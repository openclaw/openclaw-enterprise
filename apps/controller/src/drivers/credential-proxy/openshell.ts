import { randomUUID } from "node:crypto";
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
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { openShellWorkspaceName, type OpenShellGateway } from "../../backends/openshell.ts";
import {
  assertOpenShellDeploymentConfiguration,
  assertOpenShellDeploymentContext,
  assertOpenShellDeploymentRef,
  assertOpenShellInjectionPolicy,
  assertOpenShellPushedBinding,
  assertOpenShellPushedTarget,
  OpenShellCredentialDeliveryRefusedError,
  prepareOpenShellPushedProvider,
  readOpenShellPushedProvider,
} from "./openshell-pushed-provider.ts";

/** Native credential delivery for the selected OpenShell Sandbox and Backend. */
export class OpenShellCredentialProxyDriver implements CredentialProxyDriver {
  readonly capability = "credential_proxy_delivery" as const;
  readonly id: string;
  readonly implementation: string;
  private readonly backend: Backend<OpenShellGateway>;
  private readonly sandbox: SandboxDriver;

  constructor(selection: {
    readonly id: string;
    readonly implementation: string;
    readonly backend: Backend<OpenShellGateway>;
    readonly sandbox: SandboxDriver;
  }) {
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
    const supplied = input.bindings[0];
    if (
      input.bindings.length !== 1 ||
      !supplied ||
      supplied.sharedProviderRef !== undefined ||
      typeof supplied.resolveCredential !== "function"
    ) {
      throw new DependencyUnavailableError("The native credential binding is unavailable.");
    }
    const { binding } = supplied;
    assertOpenShellPushedBinding(context, binding, input.injectionPolicies);
    let target = await this.pushedTarget(context, input);
    if (typeof target.client.attachSandboxProviderWithReceipt !== "function") {
      throw new DependencyUnavailableError("Native credential attachment is unavailable.");
    }
    const prepared = await prepareOpenShellPushedProvider({
      client: target.client,
      workspace: target.workspace,
      namespaceId: context.namespace.id,
      binding,
      resolveCredential: async () => {
        await this.pushedTarget(context, input);
        return supplied.resolveCredential();
      },
      signal: context.signal,
    });
    target = await this.pushedTarget(context, input);
    const providers = target.sandbox.spec?.providers;
    if (!target.sandbox.spec || (providers !== undefined && !Array.isArray(providers))) {
      throw new DependencyUnavailableError("The native Sandbox has no Provider membership.");
    }
    if (!providers?.includes(prepared.name)) {
      const attach = target.client.attachSandboxProviderWithReceipt;
      if (typeof attach !== "function") {
        throw new DependencyUnavailableError("Native credential attachment is unavailable.");
      }
      // TODO(CP2): accepted race: a same-name replacement can reuse this version. Remove when
      // Gateway atomically enforces the expected Sandbox ID: https://github.com/NVIDIA/OpenShell/issues/5794
      const attached = await attach.call(
        target.client,
        target.workspace,
        target.name,
        prepared.name,
        context.signal,
        { expectedResourceVersion: target.sandbox.resourceVersion, requestId: randomUUID() },
      );
      if (
        !attached ||
        attached.providerId !== prepared.id ||
        attached.providerResourceVersion !== prepared.resourceVersion
      ) {
        throw new DependencyUnavailableError(
          "The native Provider attachment receipt is unavailable.",
        );
      }
      assertOpenShellPushedTarget(attached.sandbox, target.workspace, target.name, input);
      if (
        !Array.isArray(attached.sandbox.spec?.providers) ||
        !attached.sandbox.spec.providers.includes(prepared.name)
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
    if (!isDeepStrictEqual(current, prepared)) {
      throw new DependencyUnavailableError(
        "The native credential Provider changed during attachment.",
      );
    }
    const after = await this.pushedTarget(context, input);
    if (
      !Array.isArray(after.sandbox.spec?.providers) ||
      !after.sandbox.spec.providers.includes(prepared.name)
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
  }

  async getDeploymentStatus(
    context: CredentialDeploymentContext,
    expected: CredentialDeploymentConfiguration,
  ): Promise<CredentialDeploymentReadiness> {
    try {
      assertOpenShellDeploymentContext(context, this.sandbox.id);
      assertOpenShellDeploymentConfiguration(context, expected);
      // TODO(CP2): check the canonical admitted binding, policy, delivered version and
      // supervisor receipt once the deployment coordinator supplies durable admission authority.
      // Stock OpenShell also lacks qualified exact executable enforcement.
      return { state: "failed", code: "NATIVE_EXECUTABLE_AUTHORITY_UNQUALIFIED" };
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof OpenShellCredentialDeliveryRefusedError) {
        return { state: "failed", code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED" };
      }
      throw error;
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
    assertOpenShellDeploymentRef(context, input.targetRef);
    // TODO(CP3): withdraw target-bound native Providers through the coordinated lifecycle.
    throw new DependencyUnavailableError(
      "Native target-bound credential withdrawal is unavailable.",
    );
  }

  private async pushedTarget(
    context: CredentialDeploymentContext,
    expected: CredentialDeploymentConfiguration,
  ) {
    assertOpenShellDeploymentConfiguration(context, expected);
    const ref = this.sandbox.harnessResource!({
      namespace: context.namespace,
      revision: context.revision,
    });
    if (ref.agentId !== context.revision.agentId || ref.revisionId !== context.revision.id) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const client = this.backend.client.clientForNamespace(ref.namespaceName);
    const workspace = openShellWorkspaceName(context.namespace);
    const sandbox = await client.getSandbox({ workspace, name: ref.resourceName }, context.signal);
    assertOpenShellPushedTarget(sandbox, workspace, ref.resourceName, expected);
    return { client, workspace, name: ref.resourceName, sandbox };
  }
}
