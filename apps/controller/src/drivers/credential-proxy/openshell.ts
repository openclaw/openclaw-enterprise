import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { sandboxNetworkGrantsWithinCeiling } from "@openclaw-enterprise/contracts";
import type {
  Backend,
  CredentialDeploymentConfiguration,
  CredentialDeploymentContext,
  CredentialProxyDriver,
  CredentialDeploymentReadiness,
  CredentialProjection,
  CredentialProxyRouting,
  CredentialSourceReference,
  CredentialUpdateNotification,
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
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
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
  assertOpenShellInjectionPolicy,
  assertOpenShellPushedBinding,
  assertOpenShellPushedTarget,
  OpenShellCredentialDeliveryRefusedError,
  openShellPushedPolicyMatches,
  prepareOccTokenServiceProviderCopy,
  readOwnedOpenShellPushedProvider,
  readOpenShellPushedProvider,
  retireOccTokenServiceProviderCopy,
  updateOccTokenServiceProviderCopy,
} from "./openshell-pushed-provider.ts";

/** Deliver OCC TokenService credentials as Provider copies to the paired OpenShell Sandbox. */
export class OpenShellCredentialProxyDriver implements CredentialProxyDriver {
  readonly capability = "credential_proxy_delivery" as const;
  readonly id: string;
  readonly implementation: string;
  private readonly backend: Backend<OpenShellGateway>;
  private readonly sandbox: SandboxDriver &
    Pick<OpenShellSandboxDriver, "withdrawStagedCredentialRoute">;
  private sourceNamespaceResolver?: (
    sourceRef: CredentialSourceReference,
    signal: AbortSignal,
  ) => Promise<Readonly<Namespace>>;

  constructor(selection: {
    readonly id: string;
    readonly implementation: string;
    readonly tokenServiceImplementation: string;
    readonly backend: Backend<OpenShellGateway>;
    readonly sandbox: SandboxDriver & Pick<OpenShellSandboxDriver, "withdrawStagedCredentialRoute">;
  }) {
    // TODO(OpenShell TokenService): Add its shared-Provider path when that implementation is available.
    if (selection.tokenServiceImplementation !== "occ/token-service") {
      throw new Error("Native credential delivery requires the OCC TokenService implementation.");
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

  /** Internal OCC TokenService lifecycle binding; this is not a deployment operation. */
  async retireSource(
    namespace: Readonly<Namespace>,
    source: CredentialSourceReference,
    signal: AbortSignal,
  ): Promise<void> {
    if (source.namespaceId !== namespace.id) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const workspace = openShellWorkspaceName(namespace);
    await retireOccTokenServiceProviderCopy({
      client: this.backend.client.clientForNamespace(namespace.name),
      workspace,
      source,
      signal,
    });
  }

  /** Bind server-owned Source placement after platform state and Compute are available. */
  bindSourceNamespaceResolver(
    resolve: (
      sourceRef: CredentialSourceReference,
      signal: AbortSignal,
    ) => Promise<Readonly<Namespace>>,
  ): void {
    this.sourceNamespaceResolver = resolve;
  }

  async notifyCredentialUpdated(
    notification: CredentialUpdateNotification,
    resolveCredential: () => Promise<ResolvedCredential>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const sourceRef = notification.sourceRef;
    if (
      sourceRef.kind !== "credential_source" ||
      !sourceRef.id ||
      !sourceRef.namespaceId ||
      !this.sourceNamespaceResolver
    ) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const namespace = await this.sourceNamespaceResolver(sourceRef, signal);
    if (namespace.id !== sourceRef.namespaceId || namespace.status !== "ready") {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const workspace = openShellWorkspaceName(namespace);
    const client = this.backend.client.clientForNamespace(namespace.name);
    const result = await updateOccTokenServiceProviderCopy({
      client,
      workspace,
      sourceRef,
      ...(notification.version === undefined ? {} : { version: notification.version }),
      resolveCredential,
      signal,
    });
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
    }
  }

  async deployProxy(
    context: CredentialDeploymentContext,
    input: Parameters<CredentialProxyDriver["deployProxy"]>[1],
  ): Promise<{ readonly proxyRouting?: CredentialProxyRouting }> {
    assertOpenShellDeploymentContext(context, this.sandbox.id);
    assertOpenShellDeploymentRef(context, input.deployment);
    const request = assertOpenShellInjectionPolicy(input.injectionPolicies);
    if (!sandboxNetworkGrantsWithinCeiling([request], input.networkAccessPolicy.allowed)) {
      throw new DependencyUnavailableError("The native credential route is not allowed.");
    }
    return {};
  }

  async configureDeployment(
    context: CredentialDeploymentContext,
    input: Parameters<CredentialProxyDriver["configureDeployment"]>[1],
  ): Promise<{ readonly credentialProjections: readonly CredentialProjection[] }> {
    assertOpenShellDeploymentContext(context, this.sandbox.id);
    assertOpenShellDeploymentConfiguration(context, input);
    const occBinding = input.bindings[0];
    if (
      input.bindings.length !== 1 ||
      !occBinding ||
      occBinding.sharedProviderRef !== undefined ||
      typeof occBinding.resolveCredential !== "function"
    ) {
      throw new DependencyUnavailableError("The native credential binding is unavailable.");
    }
    const { binding } = occBinding;
    assertOpenShellPushedBinding(context, binding, input.injectionPolicies);
    const initialTarget = await this.readSandboxTarget(context, input);
    if (typeof initialTarget.client.attachSandboxProviderWithReceipt !== "function") {
      throw new DependencyUnavailableError("Native credential attachment is unavailable.");
    }
    const deliveryProvider = await prepareOccTokenServiceProviderCopy({
      client: initialTarget.client,
      workspace: initialTarget.workspace,
      namespaceId: context.namespace.id,
      binding,
      resolveCredential: async () => {
        await this.readSandboxTarget(context, input);
        return occBinding.resolveCredential();
      },
      signal: context.signal,
    });
    try {
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
      const current = await readOpenShellPushedProvider({
        client: target.client,
        workspace: target.workspace,
        namespaceId: context.namespace.id,
        binding,
        signal: context.signal,
      });
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
      return {
        credentialProjections: [
          {
            bindingRef: binding.bindingRef,
            environment: binding.projection.environment,
            placeholder: { kind: "runtime" },
          },
        ],
      };
    } catch (attachmentError) {
      throw await failureAfterCleanup(
        attachmentError,
        "Native credential attachment failed and Provider cleanup is unconfirmed.",
        [
          () =>
            retireOccTokenServiceProviderCopy({
              client: initialTarget.client,
              workspace: initialTarget.workspace,
              source: binding.sourceRef,
              signal: context.signal,
              retainIfAttached: true,
            }),
        ],
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
      const binding = admitted?.bindings[0];
      if (!admitted || admitted.proxyDriverId !== this.id || !binding) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      assertOpenShellPushedBinding(context, binding, admitted.injectionPolicies);
      const request = assertOpenShellInjectionPolicy(
        admitted.injectionPolicies,
        binding.bindingRef,
      );
      if (!sandboxNetworkGrantsWithinCeiling([request], admitted.networkAccessPolicy.allowed)) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const target = await this.readSandboxTarget(context, expected);
      const provider = await readOpenShellPushedProvider({
        client: target.client,
        workspace: target.workspace,
        namespaceId: context.namespace.id,
        binding,
        signal: context.signal,
      });
      if (
        !Array.isArray(target.sandbox.spec?.providers) ||
        !target.sandbox.spec.providers.includes(provider.name)
      ) {
        return { state: "pending" };
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
        admission.provider_env_revision !== config.provider_env_revision ||
        !config.provider_attachment_epoch ||
        config.provider_attachment_epoch !== target.sandbox.spec?.provider_attachment_epoch ||
        !/^[0-9a-f]{64}$/.test(String(revision.policy_hash)) ||
        !openShellPushedPolicyMatches(revision.policy, config.policy, request, provider.name)
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
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
      const after = await readOpenShellPushedProvider({
        client: target.client,
        workspace: target.workspace,
        namespaceId: context.namespace.id,
        binding,
        signal: context.signal,
      });
      if (!isDeepStrictEqual(after, provider)) {
        throw new OpenShellCredentialDeliveryRefusedError();
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
      const binding = admitted?.bindings[0];
      if (!admitted || admitted.proxyDriverId !== this.id || !binding) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      assertOpenShellPushedBinding(context, binding, admitted.injectionPolicies);
      if (input.bindingRefs && !input.bindingRefs.includes(binding.bindingRef)) {
        return;
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
      const sandbox = (await refused(readSandbox)) ?? (await absent());
      if (sandbox) {
        assertTarget(sandbox);
        const providers = sandbox.spec?.providers;
        if (!sandbox.spec || (providers !== undefined && !Array.isArray(providers))) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
        const providerName = openShellProviderName(binding.sourceRef.id);
        if (exactWithdrawal) {
          await refused(() =>
            this.sandbox.withdrawStagedCredentialRoute(
              context,
              expected.targetRef.sandboxId,
              binding.bindingRef,
            ),
          );
        }
        if (providers?.includes(providerName) || exactWithdrawal) {
          if (providers?.includes(providerName)) {
            try {
              await refused(() =>
                readOwnedOpenShellPushedProvider({
                  client: scope.client,
                  workspace: scope.workspace,
                  binding,
                  signal: context.signal,
                }),
              );
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
      await refused(() =>
        retireOccTokenServiceProviderCopy({
          client: scope.client,
          workspace: scope.workspace,
          source: binding.sourceRef,
          signal: context.signal,
          retainIfAttached: true,
        }),
      );
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
