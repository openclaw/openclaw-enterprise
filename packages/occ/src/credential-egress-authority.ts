import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  credentialFreeMetadataGrant,
  credentialFreeMetadataType,
  credentialFreeProviderRef,
  type AgentRevision,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type CapturedEgressUse,
  type ComputeDriver,
  type DriverByCapability,
  type CredentialSource,
  type EgressExchangeOwner,
  type EgressRefusal,
  type EgressRoute,
  type EgressSelectionEvidence,
  type IAMDriver,
  type Namespace,
  type ProtectedEgressSource,
  type ResourceRef,
  type SecretDriver,
  type TokenService,
} from "@openclaw-enterprise/contracts";
import { isReducedCredentialPlan } from "./credential-policy-reduction.ts";
import {
  matchesAdmittedSourceType,
  registeredCredentialProvider,
} from "./credential-provider-selection.ts";
import type { EgressAuthorityPorts, ExchangeProvider } from "./credential-proxy.ts";
import { EgressSendReceipts } from "./egress-send-receipts.ts";
import { AuthorizationDeniedError, DependencyUnavailableError } from "./errors.ts";
import type { InstalledDriver } from "./installed-driver.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

type AuthorityDecision = Readonly<{
  request: AuthorizationRequest;
  decision: AuthorizationDecision;
}>;

interface EgressAuthorityDependencies {
  readonly installationId: string;
  readonly clock: () => Date;
  readonly timestamp: () => string;
  readonly inTransaction: () => boolean;
  readonly readSnapshot: <T>(work: (state: PlatformReadView) => Promise<T>) => Promise<T>;
  readonly transact: <T>(work: (state: PlatformUnitOfWork) => Promise<T>) => Promise<T>;
  readonly lockNamespace: (
    state: PlatformUnitOfWork,
    namespaceId: string,
  ) => Promise<Readonly<Namespace>>;
  readonly proxyDriver: () => DriverByCapability["credential_proxy"];
  readonly selectedProxyOwner: () => InstalledDriver;
  readonly secretDriver: (id: string) => SecretDriver;
  readonly computeDriver: () => ComputeDriver;
  readonly credentialPlacement: () => {
    compute: ComputeDriver;
    resolve: NonNullable<ComputeDriver["resolveSandboxNamespace"]>;
  };
  readonly credentialNamespace: (namespace: Readonly<Namespace>) => Promise<Readonly<Namespace>>;
  readonly credentialGatewayOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly authorizationAuthority: (principalId: string) => IAMDriver;
  readonly authorizationDecision: (
    principalId: string,
    resource: ResourceRef,
    authority: IAMDriver,
    authorize: IAMDriver["authorize"],
  ) => Promise<AuthorityDecision>;
  readonly authorizeUse: (principalId: string, resource: ResourceRef) => Promise<AuthorityDecision>;
  readonly usesNativeAuthorization: (
    authority: IAMDriver,
    authorize: IAMDriver["authorize"],
  ) => boolean;
  readonly currentCredentialSourceOwner: (
    source: CredentialSource,
    revision: AgentRevision,
  ) => boolean;
  readonly preparedTokens: TokenService | undefined;
  readonly resolvePrepared: NonNullable<EgressAuthorityPorts["resolvePrepared"]>;
  readonly receipts: EgressAuthorityPorts["receipts"];
}

/** The source, binding and single permitted metadata operation must describe the same grant. */
function matchesCredentialFreeMetadataGrant(
  source: Readonly<CredentialSource>,
  route: EgressRoute,
) {
  const admitted = source.egress;
  const { binding } = route;
  if (
    source.type !== credentialFreeMetadataType ||
    admitted?.adoption !== "credential_free" ||
    !isDeepStrictEqual(admitted.key.provider, credentialFreeProviderRef) ||
    !isDeepStrictEqual(binding.source, admitted.key)
  ) {
    return false;
  }
  const grant = credentialFreeMetadataGrant(source.config);
  return (
    admitted.origin === source.config.origin &&
    route.origin === admitted.origin &&
    route.method === "GET" &&
    route.path === `/repos/${grant.repository}` &&
    grant.isolationId === binding.execution.agentId &&
    grant.isolationId === binding.isolationId &&
    isDeepStrictEqual(admitted.grant, grant) &&
    isDeepStrictEqual(binding.grant, grant) &&
    binding.grantHash === createHash("sha256").update(JSON.stringify(grant)).digest("hex")
  );
}

/** Supply the OCC-side authority and storage ports for one exchange owner. */
export function createEgressAuthority(
  exchangeOwner: EgressExchangeOwner,
  dependencies: EgressAuthorityDependencies,
): EgressAuthorityPorts {
  async function denyEgressUse(
    state: PlatformUnitOfWork,
    use: Pick<CapturedEgressUse, "id" | "route">,
    code: Extract<EgressRefusal, { kind: "denied" }>["code"],
    material?: EgressSelectionEvidence,
    stream?: { readonly until: string },
    classificationRule?: number,
  ): Promise<EgressRefusal> {
    const execution = use.route.binding.execution;
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: dependencies.installationId,
      namespaceId: execution.namespaceId,
      occurredAt: dependencies.timestamp(),
      kind: "authorization_denial",
      actorId: execution.servicePrincipalId,
      source: "occ",
      action: "openclaw.egress.authorize",
      resource: {
        kind: "credential_source",
        namespaceId: execution.namespaceId,
        id: use.route.binding.source.source.id,
      },
      outcome: "denied",
      details: {
        code,
        phase: stream
          ? "during_response"
          : material === undefined
            ? "before_access"
            : "before_send",
        requestId: use.id,
        revisionId: execution.revisionId,
        ...(classificationRule === undefined ? {} : { classificationRule }),
      },
    });
    return { kind: "denied", code };
  }

  async function checkEgressUseIn(
    state: PlatformUnitOfWork,
    use: CapturedEgressUse,
    material?: EgressSelectionEvidence,
    stream?: { readonly until: string },
    finalCheck?: {
      readonly namespace: Readonly<Namespace>;
      readonly revision: Readonly<AgentRevision>;
      readonly decision: AuthorizationDecision;
    },
    selectedProvider?: ExchangeProvider,
  ): Promise<ProtectedEgressSource | EgressRefusal> {
    const execution = use.route.binding.execution;
    const target = {
      kind: "credential_source" as const,
      namespaceId: execution.namespaceId,
      id: use.route.binding.source.source.id,
    };
    const deny = (code: Extract<EgressRefusal, { kind: "denied" }>["code"]) =>
      denyEgressUse(state, use, code, material, stream);
    if (
      execution.installationId !== dependencies.installationId ||
      !isDeepStrictEqual(execution, use.installation.plan.execution)
    ) {
      return deny("scope_mismatch");
    }
    const namespace = await state.namespaces.findNamespace(execution.namespaceId);
    const agent = await state.agents.findAgent(execution.namespaceId, execution.agentId);
    const revision = await state.revisions.findRevision(
      execution.namespaceId,
      execution.agentId,
      execution.revisionId,
    );
    const installed = await state.credentialSources.findEgressInstallation(
      use.peer.sender.id,
      use.peer.sandboxId,
    );
    if (
      !namespace ||
      namespace.status !== "ready" ||
      !agent ||
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      agent.servicePrincipalId !== execution.servicePrincipalId ||
      !revision ||
      !isReducedCredentialPlan(revision.egressPlan, use.installation.plan) ||
      !isDeepStrictEqual(installed, use.installation)
    ) {
      return deny("withdrawn");
    }
    // A provisioned revision may probe before activation. It must still be the newest
    // admitted running revision; an older or superseded execution cannot keep using egress.
    if (
      agent.activeRevisionId !== execution.revisionId &&
      (await state.revisions.listRevisionMetadata(execution.namespaceId, execution.agentId)).at(-1)
        ?.id !== execution.revisionId
    ) {
      return deny("withdrawn");
    }
    const source = await state.credentialSources.lockCredentialSource(
      execution.namespaceId,
      target.id,
    );
    const withdrawal = await state.credentialSources.findCredentialWithdrawal(
      execution.namespaceId,
      execution.revisionId,
      target.id,
    );
    if (!source || source.state !== "ready" || withdrawal !== undefined) {
      return deny("withdrawn");
    }
    const admitted = source.egress;
    const driver = dependencies.proxyDriver();
    const control = driver.sourceControl;
    if (
      !admitted ||
      !dependencies.currentCredentialSourceOwner(source, revision) ||
      !dependencies.selectedProxyOwner().ownsProxyPlan(use.installation.plan) ||
      (use.installation.plan.policyReductionVersion !== undefined &&
        driver.policyReduction?.version !== use.installation.plan.policyReductionVersion) ||
      !isDeepStrictEqual(admitted.key, use.route.binding.source) ||
      !isDeepStrictEqual(admitted.key.backend, control.backend) ||
      !isDeepStrictEqual(admitted.sender, use.peer.sender) ||
      !isDeepStrictEqual(admitted.resolver, control.resolver) ||
      !isDeepStrictEqual(admitted.sender, control.sender)
    ) {
      return deny("stale_configuration");
    }
    // A leased response stream is bounded by its lease, not the operation deadline.
    const remaining =
      Date.parse(stream?.until ?? use.request.deadlineAt) - dependencies.clock().getTime();
    if (remaining <= 0) {
      return { kind: "deadline_exceeded" };
    }
    // A stored installation is an immutable association, not a readiness lease.
    // The selected adapter rechecks the current authenticated runtime at both checks.
    if (
      finalCheck
        ? !isDeepStrictEqual(finalCheck.namespace, namespace) ||
          !isDeepStrictEqual(finalCheck.revision, revision)
        : !(await driver.verifyInstallation(
            {
              namespace: await dependencies.credentialNamespace(namespace),
              revision,
              plan: use.installation.plan,
              signal: AbortSignal.timeout(Math.ceil(remaining)),
            },
            use.installation,
          ))
    ) {
      return deny("stale_configuration");
    }
    if (!selectedProvider?.isCurrent()) {
      return deny("stale_configuration");
    }
    const provider = selectedProvider.receiver;
    if (!matchesAdmittedSourceType(source, provider)) {
      return deny("stale_configuration");
    }
    try {
      const routes = Reflect.apply(selectedProvider.methods.routes, provider, [
        source,
        use.route.binding,
        revision.harness.configuration,
      ]);
      if (!routes.some((route) => isDeepStrictEqual(route, use.route))) {
        return deny("stale_configuration");
      }
    } catch {
      return deny("stale_configuration");
    }
    if (
      !isDeepStrictEqual(
        Reflect.apply(selectedProvider.methods.classify, provider, [use.route, use.request]),
        use.operation,
      ) ||
      !selectedProvider.isCurrent() ||
      !use.installation.plan.routes.some((route) => isDeepStrictEqual(route, use.route))
    ) {
      return deny("unsupported_operation");
    }
    try {
      if (finalCheck) {
        if (!finalCheck.decision.allowed) {
          return deny("unauthorized");
        }
      } else {
        await dependencies.authorizeUse(execution.servicePrincipalId, target);
      }
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        return deny("unauthorized");
      }
      throw error;
    }
    if (admitted.adoption === "credential_free") {
      const { binding } = use.route;
      if (
        use.operation.kind !== "credential_free_repository_metadata" ||
        !matchesCredentialFreeMetadataGrant(source, use.route) ||
        (material !== undefined &&
          !isDeepStrictEqual(material, {
            kind: "no_material_required",
            source: binding.source,
            binding: binding.binding,
            grantHash: binding.grantHash,
            isolationId: binding.isolationId,
          }))
      ) {
        return deny("scope_mismatch");
      }
      return admitted;
    }
    if (material?.kind === "no_material_required") {
      return deny("scope_mismatch");
    }
    if (admitted.adoption === "prepared") {
      const lifecycle = dependencies.preparedTokens?.issuer(admitted.key.provider);
      if (!selectedProvider.isCurrent()) {
        return deny("stale_configuration");
      }
      const grant = Reflect.apply(selectedProvider.methods.normalizeGrant, provider, [
        [],
        source.config,
      ]);
      if (
        !lifecycle ||
        !isDeepStrictEqual(admitted, lifecycle.sourceFromRoute(use.route, control)) ||
        use.route.binding.grantHash !==
          createHash("sha256").update(JSON.stringify(grant)).digest("hex")
      ) {
        return deny("scope_mismatch");
      }
      if (material !== undefined) {
        const left = Date.parse(use.request.deadlineAt) - dependencies.clock().getTime();
        if (
          material.kind !== (admitted.schemaVersion === 2 ? "prepared_github" : "prepared_token") ||
          left <= 0 ||
          material.grantHash !== use.route.binding.grantHash ||
          material.isolationId !== execution.agentId ||
          !isDeepStrictEqual(material.source, admitted.key) ||
          !isDeepStrictEqual(material.binding, use.route.binding.binding) ||
          (await state.credentialSources.isEgressMaterialRejected(material)) ||
          !(await state.preparedTokenProof.current(admitted, material, lifecycle.issuerAuthority, {
            signal: AbortSignal.timeout(Math.ceil(left)),
            deadlineAt: use.request.deadlineAt,
          }))
        ) {
          // Withdrawal was checked under the source lock. This selection could not be proved current.
          return deny("stale_configuration");
        }
      }
      return admitted;
    }
    if (material !== undefined) {
      const secret = await state.secrets.findSecret(
        admitted.secret.namespaceId,
        admitted.secret.id,
      );
      if (
        material.kind !== "static" ||
        !secret ||
        secret.driverId !== admitted.secretDriver.id ||
        secret.backendRef.uid !== material.materialId ||
        !isDeepStrictEqual(material.source, admitted.key) ||
        !isDeepStrictEqual(material.binding, use.route.binding.binding) ||
        !isDeepStrictEqual(material.secret, admitted.secret) ||
        !isDeepStrictEqual(material.secretDriver, admitted.secretDriver) ||
        material.adoption !== admitted.adoption ||
        material.materialRefId !== admitted.materialRefId ||
        material.grantHash !== use.route.binding.grantHash ||
        material.isolationId !== use.route.binding.isolationId ||
        material.retention !== "none" ||
        Date.parse(material.usableUntil) <= dependencies.clock().getTime() ||
        (await state.credentialSources.isEgressMaterialRejected(material))
      ) {
        return deny("withdrawn");
      }
    }
    return admitted;
  }

  return {
    exchangeOwner,
    now: () => dependencies.clock().getTime(),
    installation: (peer) =>
      dependencies.readSnapshot((state) =>
        state.credentialSources.findEgressInstallation(peer.sender.id, peer.sandboxId),
      ),
    provider: (route) => {
      const control = dependencies.proxyDriver().sourceControl;
      if (!isDeepStrictEqual(control.backend, route.binding.source.backend)) {
        return undefined;
      }
      return registeredCredentialProvider(control.providers, route.binding.source.provider);
    },
    classificationRefused: async (use, rule) => {
      const execution = use.route.binding.execution;
      if (
        dependencies.inTransaction() ||
        execution.installationId !== dependencies.installationId ||
        !isDeepStrictEqual(execution, use.installation.plan.execution)
      ) {
        throw new DependencyUnavailableError("Classification audit scope is unavailable.");
      }
      await dependencies.transact((state) =>
        denyEgressUse(state, use, "unsupported_operation", undefined, undefined, rule),
      );
    },
    async check(use, material, stream, provider) {
      // Each RPC uses a fresh policy unit. Native IAM loads policy inside that unit.
      if (dependencies.inTransaction()) {
        return { kind: "unavailable", code: "authority" };
      }
      return dependencies.transact((state) =>
        checkEgressUseIn(state, use, material, stream, undefined, provider),
      );
    },
    read: async (source, lifetime, isProviderCurrent) => {
      const owner = dependencies.selectedProxyOwner();
      const control = owner.require("credential_proxy").sourceControl;
      const secret = await dependencies.readSnapshot((state) =>
        state.secrets.findSecret(source.secret.namespaceId, source.secret.id),
      );
      if (lifetime.signal.aborted || !secret || secret.driverId !== source.secretDriver.id) {
        throw new DependencyUnavailableError("Selected credential material is unavailable.");
      }
      const driver = dependencies.secretDriver(secret.driverId);
      if (!driver.readCredentialInput) {
        throw new DependencyUnavailableError("Versioned credential reading is unavailable.");
      }
      if (
        dependencies.selectedProxyOwner() !== owner ||
        owner.require("credential_proxy").sourceControl !== control ||
        !isDeepStrictEqual(control.backend, source.key.backend) ||
        !isDeepStrictEqual(control.sender, source.sender) ||
        !isDeepStrictEqual(control.resolver, source.resolver) ||
        !isProviderCurrent()
      ) {
        throw new DependencyUnavailableError("Selected credential provider changed.");
      }
      return {
        ...(await driver.readCredentialInput({ secret, lifetime, retention: "none" })),
        materialId: secret.backendRef.uid,
      };
    },
    resolvePrepared: dependencies.resolvePrepared,
    authorizeSend: async (use, source, attempt, mintAuthorization, provider) => {
      if (dependencies.inTransaction()) {
        return { kind: "unavailable", code: "authority" };
      }
      const material = attempt.material;
      if (!material) {
        return { kind: "denied", code: "scope_mismatch" };
      }
      const execution = use.route.binding.execution;
      const deny = (code: Extract<EgressRefusal, { kind: "denied" }>["code"]) =>
        dependencies.transact((state) => denyEgressUse(state, use, code, material));
      const driver = dependencies.proxyDriver();
      const verify = driver.verifyInstallation;
      const { compute, resolve } = dependencies.credentialPlacement();
      // No policy/source locks and no one-second permit during trusted runtime I/O.
      const runtime = await dependencies.readSnapshot(async (state) => ({
        namespace: await state.namespaces.findNamespace(execution.namespaceId),
        revision: await state.revisions.findRevision(
          execution.namespaceId,
          execution.agentId,
          execution.revisionId,
        ),
        installed: await state.credentialSources.findEgressInstallation(
          use.peer.sender.id,
          use.peer.sandboxId,
        ),
      }));
      const remaining = Date.parse(use.request.deadlineAt) - dependencies.clock().getTime();
      if (remaining <= 0) {
        return { kind: "deadline_exceeded" };
      }
      if (
        !runtime.namespace ||
        !runtime.revision ||
        !isDeepStrictEqual(runtime.installed, use.installation)
      ) {
        return deny("stale_configuration");
      }
      const { namespace, revision } = runtime;
      const verified = await Reflect.apply(verify, driver, [
        {
          namespace: await dependencies.credentialGatewayOperation(() =>
            Reflect.apply(resolve, compute, [namespace]),
          ),
          revision,
          plan: use.installation.plan,
          signal: AbortSignal.timeout(Math.ceil(remaining)),
        },
        use.installation,
      ]);
      if (verified !== true) {
        return verified === false
          ? deny("stale_configuration")
          : { kind: "unavailable", code: "authority" };
      }
      const authority = dependencies.authorizationAuthority(execution.servicePrincipalId);
      const authorize = authority.authorize;
      const decide = () =>
        dependencies.authorizationDecision(
          execution.servicePrincipalId,
          {
            kind: "credential_source",
            namespaceId: execution.namespaceId,
            id: use.route.binding.source.source.id,
          },
          authority,
          authorize,
        );
      const native = dependencies.usesNativeAuthorization(authority, authorize);
      const observed = native ? undefined : await decide();
      if (observed && !observed.decision.allowed) {
        return deny("unauthorized");
      }
      return dependencies.transact(async (state) => {
        await dependencies.lockNamespace(state, execution.namespaceId);
        const decision = observed ?? (await decide());
        await state.agents.lockAgent(execution.namespaceId, execution.agentId);
        const current = await checkEgressUseIn(
          state,
          use,
          material,
          undefined,
          { namespace, revision, decision: decision.decision },
          provider,
        );
        if (!("key" in current)) {
          return current;
        }
        if (
          !isDeepStrictEqual(current, source) ||
          dependencies.proxyDriver() !== driver ||
          driver.verifyInstallation !== verify ||
          dependencies.computeDriver() !== compute ||
          compute.resolveSandboxNamespace !== resolve ||
          dependencies.authorizationAuthority(execution.servicePrincipalId) !== authority ||
          authority.authorize !== authorize ||
          !provider.isCurrent()
        ) {
          return denyEgressUse(state, use, "stale_configuration", material);
        }
        const authorization = mintAuthorization();
        if ("kind" in authorization) {
          return authorization;
        }
        return EgressSendReceipts.authorizeIn(
          state.egressSendReceipts,
          use.peer.sender,
          attempt,
          authorization,
        );
      });
    },
    receipts: dependencies.receipts,
  };
}
