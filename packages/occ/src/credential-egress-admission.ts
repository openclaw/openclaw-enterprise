import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  credentialFreeMetadataGrant,
  credentialFreeMetadataType,
  credentialFreeProviderRef,
  credentialSourceMatchesSnapshot,
  isInstallationRepositoryProfile,
  repositoryGitAuthorization,
  repositoryGitDeliveryProfile,
  type Agent,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type CredentialFreeEgressSource,
  type CredentialProviderDefinition,
  type CredentialSource,
  type CredentialSourceType,
  type DriverByCapability,
  type EgressRef,
  type HarnessAuthSnapshot,
  type OpenClawConfigurationDocument,
  type PreparedTokenIssuer,
  type PreparedTokenSource,
  type ProxyPlan,
  type RepositoryRevisionState,
  type Secret,
  type SecretDriver,
  type SecretReference,
  type StaticEgressSource,
  type TokenService,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";
import {
  matchesAdmittedSourceType,
  registeredCredentialProvider,
} from "./credential-provider-selection.ts";
import { supportsStaticCredentials } from "./credential-proxy.ts";
import {
  CREDENTIAL_GATEWAY_TIMEOUT_MS,
  type CredentialSourceDrivers,
} from "./credential-source-drivers.ts";
import {
  AgentDeletingError,
  ConfigurationHarnessError,
  CredentialProxyAdmissionError,
  CredentialSourceTypeNotOfferedError,
  CredentialSourceUnprotectedError,
  DependencyUnavailableError,
  RepositoryGitProfileUnsupportedError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretBindingValidationError,
} from "./errors.ts";
import type { InstalledDriver } from "./installed-driver.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

export const CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES =
  "Credential source Secrets cannot cross Namespaces.";

interface CredentialEgressAdmissionDependencies {
  readonly installationId: () => string;
  readonly authorize: (
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: AuthorizationRequest["resource"],
  ) => Promise<Readonly<{ request: AuthorizationRequest; decision: AuthorizationDecision }>>;
  readonly hasProxy: () => boolean;
  readonly proxyDriver: () => DriverByCapability["credential_proxy"];
  readonly proxyRegistrationOwner: () => InstalledDriver | undefined;
  readonly selectedProxyOwner: () => InstalledDriver;
  readonly hasGateway: () => boolean;
  readonly sourceDrivers: Pick<
    CredentialSourceDrivers,
    "credentialGatewayDriver" | "credentialSourceType"
  >;
  readonly secretDriver: (id: string) => SecretDriver;
  readonly issuer: (ref: EgressRef) => ReturnType<TokenService["issuer"]>;
}

export function createCredentialEgressAdmission(
  dependencies: CredentialEgressAdmissionDependencies,
) {
  async function admitPreparedTokenSource(
    lifecycle: Pick<PreparedTokenIssuer, "admission" | "provider">,
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    sourceId: string,
    config: Readonly<Record<string, string>>,
    issuer: SecretReference,
  ): Promise<{ source: PreparedTokenSource; issuer: Readonly<Secret> }> {
    const control = dependencies.proxyDriver().sourceControl;
    const { origin, grant, schemaVersion } = lifecycle.admission(config);
    await requireProtectedSourceAgent(
      state,
      principalId,
      namespaceId,
      grant.isolationId,
      "A prepared credential source requires an Agent in this Namespace.",
    );
    if (issuer?.namespaceId !== namespaceId) {
      throw new SecretBindingValidationError(CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);
    }
    if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin)) {
      // The origin is the Installation's issuer setting, validated at startup.
      throw new ScopeViolationError(
        "A prepared credential source requires a trusted HTTPS origin.",
      );
    }
    await dependencies.authorize(principalId, "operate", issuer);
    const secret = await state.secrets.lockSecret(namespaceId, issuer.id);
    if (!secret) {
      throw new ScopeViolationError("Prepared credential issuer material is unavailable.");
    }
    await control.assertAvailable(AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS));
    return {
      source: immutableCopy({
        key: {
          installationId: dependencies.installationId(),
          namespaceId,
          source: { id: sourceId, generation: 1 },
          provider: lifecycle.provider,
          backend: control.backend,
        },
        sender: control.sender,
        resolver: control.resolver,
        origin,
        grant,
        schemaVersion,
        adoption: "prepared" as const,
        retention: "none" as const,
      }),
      issuer: secret,
    };
  }

  async function requireProtectedSourceAgent(
    state: PlatformReadView,
    principalId: string,
    namespaceId: string,
    id: string,
    missingAgentMessage: string,
  ): Promise<void> {
    await dependencies.authorize(principalId, "operate", { kind: "agent", namespaceId, id });
    const agent = await state.agents.findAgent(namespaceId, id);
    // The caller holds operate on the exact Agent before its state is disclosed.
    if (!agent) {
      throw new ScopeViolationError(missingAgentMessage);
    }
    if (agent.status !== "active") {
      throw new AgentDeletingError();
    }
    if (agent.executionMode !== "dedicated") {
      throw new ResourceStateConflictError(
        "config.agent_id names an embedded Agent, and a protected credential source serves only a dedicated Agent. Name a dedicated Agent in this Namespace.",
      );
    }
  }

  async function admitCredentialFreeMetadata(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    sourceId: string,
    config: Readonly<Record<string, string>>,
  ): Promise<CredentialFreeEgressSource> {
    const control = dependencies.proxyDriver().sourceControl;
    const grant = credentialFreeMetadataGrant(config);
    await requireProtectedSourceAgent(
      state,
      principalId,
      namespaceId,
      grant.isolationId,
      "Credential-free metadata requires this dedicated Agent.",
    );
    await control.assertAvailable(AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS));
    return immutableCopy({
      key: {
        installationId: dependencies.installationId(),
        namespaceId,
        source: { id: sourceId, generation: 1 },
        provider: credentialFreeProviderRef,
        backend: control.backend,
      },
      sender: control.sender,
      resolver: control.resolver,
      origin: config.origin!,
      grant,
      schemaVersion: 3 as const,
      adoption: "credential_free" as const,
      retention: "none" as const,
    });
  }

  function staticEgressProvider(gatewayType: CredentialSourceType, previous?: EgressRef) {
    const type = gatewayType.type;
    const driver = dependencies.proxyDriver();
    const owner = dependencies.proxyRegistrationOwner();
    const control = driver.sourceControl;
    // A new admission uses catalog order. An existing approval names a specific registration.
    const resolve = () => {
      const ref =
        previous ?? control.providers.find((entry) => entry.sourceType.type === type)?.ref;
      return ref ? registeredCredentialProvider(control.providers, ref) : undefined;
    };
    const provider = resolve();
    if (provider === "ambiguous") {
      throw new ResourceStateConflictError(
        "The admitted credential provider has duplicate registrations. Ask an Installation administrator to resolve them.",
      );
    }
    if (!provider) {
      return undefined;
    }
    const ref = immutableCopy(provider.ref);
    // Catalog entries may be retained by their Drivers across asynchronous admission.
    const admittedGatewayType = immutableCopy(gatewayType);
    const admittedProviderType = immutableCopy(provider.sourceType);
    const { inject, normalizeConfig } = provider;
    const assertCurrent = () => {
      if (
        dependencies.proxyDriver() !== driver ||
        dependencies.proxyRegistrationOwner() !== owner ||
        (owner !== undefined && owner.require("credential_proxy") !== driver) ||
        driver.sourceControl !== control ||
        resolve() !== provider ||
        !isDeepStrictEqual(gatewayType, admittedGatewayType) ||
        !isDeepStrictEqual(provider.sourceType, admittedProviderType) ||
        !isDeepStrictEqual(provider.ref, ref) ||
        provider.inject !== inject ||
        provider.normalizeConfig !== normalizeConfig
      ) {
        throw new ResourceStateConflictError(
          "The selected credential provider changed during admission. Check the Installation's provider configuration before retrying this credential-source request.",
        );
      }
      owner?.assertNewStaticProviderUse(ref);
    };
    return { provider, ref, inject, normalizeConfig, assertCurrent, gatewayType };
  }

  async function admitStaticEgressSource(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    sourceId: string,
    type: string,
    config: Readonly<Record<string, string>>,
    references: Readonly<Record<string, SecretReference>>,
    generation: number,
    selection: ReturnType<typeof staticEgressProvider>,
  ): Promise<StaticEgressSource> {
    const control = dependencies.proxyDriver().sourceControl;
    if (
      !selection ||
      selection.gatewayType.type !== type ||
      selection.provider.sourceType.type !== type ||
      !staticSourceLifecycleMatches(selection.gatewayType, selection.provider.sourceType) ||
      selection.provider.sourceType.secrets.length !== 1
    ) {
      // An Installation property about the type the request sent. The who comes
      // before the type list, so the 256-character cap never cuts it.
      throw new ResourceStateConflictError(
        `The selected Credential Proxy cannot protect ${type} sources. Ask an Installation administrator, or create a type it protects: ${control.providers.map((entry) => entry.sourceType.type).join(", ")}.`,
      );
    }
    const { provider, ref, inject, normalizeConfig, assertCurrent } = selection;
    const reference = references[provider.sourceType.secrets[0]!.name];
    assertCurrent();
    Reflect.apply(normalizeConfig, provider, [config]);
    // An Installation property: a Proxy that cannot serve the source refuses it before any
    // Secret is read.
    await control.assertAvailable(AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS));
    if (!reference) {
      throw new ScopeViolationError(
        "Protected source material must belong to the exact Namespace.",
      );
    }
    if (reference.namespaceId !== namespaceId) {
      // The reference the request sent, refused as the Credential Gateway path refuses it.
      throw new SecretBindingValidationError(CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);
    }
    await dependencies.authorize(principalId, "operate", reference);
    const secret = await state.secrets.lockSecret(namespaceId, reference.id);
    if (!secret) {
      throw new ScopeViolationError("Protected source material is unavailable.");
    }
    const secretDriver = dependencies.secretDriver(secret.driverId);
    if (!secretDriver.readCredentialInput) {
      throw new DependencyUnavailableError(
        "Protected egress requires authoritative versioned Secret reads.",
      );
    }
    const signal = AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS);
    assertCurrent();
    const material = await secretDriver.readCredentialInput({
      secret,
      lifetime: {
        signal,
        deadlineAt: new Date(Date.now() + CREDENTIAL_GATEWAY_TIMEOUT_MS).toISOString(),
      },
      retention: "none",
    });
    // Validate format before committing the candidate, without retaining or exporting material.
    assertCurrent();
    Reflect.apply(inject, provider, [material.value]);
    assertCurrent();
    if (!material.version || !Number.isFinite(Date.parse(material.authoritativeObservedAt))) {
      throw new DependencyUnavailableError("The Secret Driver returned no version evidence.");
    }
    return immutableCopy({
      key: {
        installationId: dependencies.installationId(),
        namespaceId,
        source: { id: sourceId, generation },
        backend: control.backend,
        provider: ref,
      },
      schemaVersion: 1 as const,
      adoption: "live" as const,
      materialRefId: crypto.randomUUID(),
      secret: reference,
      secretDriver: { id: secretDriver.id, generation: 1 },
      sender: control.sender,
      resolver: control.resolver,
      retention: "none" as const,
    });
  }

  async function admitProxyPlan(
    state: PlatformUnitOfWork,
    agent: Readonly<Agent>,
    revisionId: string,
    configuration: OpenClawConfigurationDocument,
    sandboxDriverId?: string,
    repositoryGit?: RepositoryRevisionState,
    harnessAuth?: HarnessAuthSnapshot,
    harnessConfiguration?: Readonly<Record<string, unknown>>,
  ): Promise<{ plan: ProxyPlan; assertProvidersCurrent: () => void } | undefined> {
    const sources: CredentialSource[] = [];
    let harnessCredentialSource: ProxyPlan["harnessCredentialSource"];
    for (const binding of agent.credentialSources ?? []) {
      const source = await state.credentialSources.findCredentialSource(
        agent.namespaceId,
        binding.sourceId,
      );
      if (source?.egress !== undefined) {
        sources.push(source);
      } else if (
        repositoryGit &&
        source?.state === "ready" &&
        harnessAuth?.method === "credential_source" &&
        harnessAuth.credentialGatewayId !== undefined &&
        source.id === harnessAuth.sourceId &&
        credentialSourceMatchesSnapshot(source, harnessAuth)
      ) {
        // admitHarnessAuth and admitCredentialSources already authorized this ordinary
        // Harness source. Bind its identity to release, without giving Git any model authority.
        harnessCredentialSource = harnessAuth;
      }
    }
    // Each refusal below is an Installation property or the Agent's saved bindings, after the
    // deploy grant and the authorization of every bound source: a retry never helps, so each is a
    // 409 with fixed text that names no source or repository.
    const installationAccess = isInstallationRepositoryProfile(repositoryGit?.bindings[0]?.profile);
    if (!dependencies.hasProxy()) {
      if (installationAccess) {
        throw new CredentialProxyAdmissionError("installationAccess");
      }
      if (sources.length > 0) {
        throw new CredentialProxyAdmissionError("sourcesWithoutProxy");
      }
      return undefined;
    }
    // Only a positively installed repository-only owner permits ordinary model delivery.
    // Source-free Agents and full/unknown profiles retain protected admission, including empty plans.
    if (
      sources.length === 0 &&
      repositoryGit === undefined &&
      harnessAuth !== undefined &&
      dependencies.selectedProxyOwner().allowsOrdinaryCredentialGateway() &&
      (await ordinaryModelBinding(state, agent, harnessAuth))
    ) {
      return undefined;
    }
    const sourceCount = sources.length + (harnessCredentialSource ? 1 : 0);
    const owner = dependencies.selectedProxyOwner();
    const driver = owner.require("credential_proxy");
    // Retirement is permanent; an unavailable counterpart cannot make this deployment retryable.
    for (const source of sources) {
      if (source.egress?.adoption === "live") {
        owner.assertNewStaticProviderUse(source.egress.key.provider);
      }
    }
    if ((agent.credentialSources?.length ?? 0) !== sourceCount) {
      throw new CredentialSourceUnprotectedError();
    }
    if (sourceCount > 1 && !repositoryGit && driver.policyReduction?.version !== 1) {
      throw new CredentialProxyAdmissionError("oneSource");
    }
    // Deploy refuses a selected Sandbox with another execution mode first
    // (requireSandboxExecutionMode), so this is an Installation without a Sandbox Driver.
    if (!sandboxDriverId || agent.executionMode !== "dedicated") {
      throw new CredentialProxyAdmissionError("dedicatedSandbox");
    }
    if (installationAccess) {
      owner.requireRepositoryGitTransport();
    }
    const gitProfile = repositoryGitDeliveryProfile(repositoryGit);
    if (repositoryGit !== undefined && gitProfile === undefined) {
      // Protected admission v4–v7 requires a mapped delivery profile. Refuse unsupported
      // profiles before checking counterpart availability.
      throw new RepositoryGitProfileUnsupportedError(repositoryGit.bindings.length);
    }
    const gitAuthorization = await repositoryGitAuthorization(
      driver.sourceControl,
      AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      gitProfile,
    );
    if (gitAuthorization === "unavailable") {
      throw new DependencyUnavailableError(
        "The selected Credential Proxy did not confirm installation-wide repository access.",
      );
    }
    const reducibleGit =
      gitProfile !== undefined &&
      gitAuthorization === "exact-dispatch" &&
      driver.policyReduction?.version === 2;
    if (repositoryGit && sources.length && !reducibleGit) {
      throw new CredentialProxyAdmissionError("gitAlone");
    }
    if (reducibleGit && driver.policyReduction?.version === 2) {
      await driver.policyReduction.assertAvailable(
        AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      );
    }
    let policyReductionVersion: ProxyPlan["policyReductionVersion"] = reducibleGit ? 2 : undefined;
    if (!repositoryGit && sources.length > 0 && driver.policyReduction?.version === 1) {
      policyReductionVersion = 1;
    }
    const selection = asRecord(asRecord(configuration.agents)?.defaults)?.model;
    const model = typeof selection === "string" ? selection : asRecord(selection)?.primary;
    if (
      sources.some((source) => source.egress?.adoption === "live") &&
      (typeof model !== "string" || !model.includes("/"))
    ) {
      // The caller holds read on the Agent's Configuration (deploy checked it), so the refusal
      // names the setting, as other Configuration Harness refusals do.
      throw new ConfigurationHarnessError(
        "Configuration setting agents.defaults.model must name a provider/model: a live-adopted credential source routes protected inference only to an explicit provider. Set it in the Agent's Configuration, then deploy again.",
      );
    }
    const modelId = typeof model === "string" ? model.slice(model.indexOf("/") + 1) : "";
    const execution = {
      installationId: dependencies.installationId(),
      namespaceId: agent.namespaceId,
      agentId: agent.id,
      servicePrincipalId: agent.servicePrincipalId,
      revisionId,
      executionId: repositoryGit ? randomBytes(24).toString("base64url") : crypto.randomUUID(),
    };
    const control = driver.sourceControl;
    const requireProvider = (source: CredentialSource, expected?: CredentialProviderDefinition) => {
      const admitted = source.egress!;
      const provider = registeredCredentialProvider(control.providers, admitted.key.provider);
      if (
        provider === "ambiguous" ||
        (expected && provider !== expected) ||
        (provider && !matchesAdmittedSourceType(source, provider))
      ) {
        throw new ResourceStateConflictError(
          "The admitted credential provider changed or is incompatible. Ask an Installation administrator to restore its unique registration.",
        );
      }
      if (!provider || !isDeepStrictEqual(control.backend, admitted.key.backend)) {
        throw new DependencyUnavailableError("The admitted egress composition is unavailable.");
      }
      return provider;
    };
    const registrations = sources.map((source) => ({ source, provider: requireProvider(source) }));
    const routes = registrations.flatMap(({ source, provider }) => {
      const admitted = source.egress!;
      const grant = provider.normalizeGrant([modelId], source.config);
      let digestGrant = grant;
      if (source.type === credentialFreeMetadataType && admitted.adoption === "credential_free") {
        const canonical = credentialFreeMetadataGrant(source.config);
        if (!isDeepStrictEqual(grant, canonical)) {
          throw new ScopeViolationError(
            "Credential-free metadata grant does not match the source.",
          );
        }
        // Preserve the contracts digest without dropping any Driver-supplied grant fields.
        digestGrant = canonical;
      }
      return provider.routes(
        source,
        {
          binding: { id: crypto.randomUUID(), generation: 1 },
          execution,
          source: admitted.key,
          grant,
          grantHash: createHash("sha256").update(JSON.stringify(digestGrant)).digest("hex"),
          isolationId: agent.id,
        },
        harnessConfiguration,
      );
    });
    const plan: ProxyPlan = immutableCopy({
      id: crypto.randomUUID(),
      generation: 1,
      execution,
      sandboxDriverId,
      egressDriverId: driver.id,
      driver: owner.ref,
      ...(policyReductionVersion !== undefined && { policyReductionVersion }),
      ...(repositoryGit && { repositoryGit }),
      ...(repositoryGit &&
        (gitAuthorization === "online-request" || gitAuthorization === "request-hook-observed") && {
          repositoryGitAuthorization: gitAuthorization,
        }),
      ...(harnessCredentialSource && { harnessCredentialSource }),
      routes,
    });
    // The plan is durable; the receiver identities stay local to this admission.
    const assertProvidersCurrent = () => {
      if (registrations.length === 0) {
        return;
      }
      if (dependencies.selectedProxyOwner() !== owner || driver.sourceControl !== control) {
        throw new ResourceStateConflictError(
          "The selected Credential Proxy changed during deployment.",
        );
      }
      for (const { source, provider } of registrations) {
        requireProvider(source, provider);
      }
    };
    return { plan, assertProvidersCurrent };
  }

  function ordinaryCredentialGatewayAllowed(type: CredentialSourceType): boolean {
    return (
      !dependencies.hasProxy() ||
      (dependencies.selectedProxyOwner().allowsOrdinaryCredentialGateway() &&
        type.harnessAuth !== undefined &&
        staticSourceLifecycleMatches(type))
    );
  }

  /** The compatibility grant covers only the model Harness, never other bound sources. */
  async function ordinaryModelBinding(
    state: PlatformReadView,
    agent: Readonly<Agent>,
    admitted?: HarnessAuthSnapshot,
  ): Promise<boolean> {
    const auth = agent.harnessAuth;
    if (
      auth?.method !== "credential_source" ||
      agent.credentialSources?.length !== 1 ||
      agent.credentialSources[0]?.sourceId !== auth.sourceId ||
      !dependencies.hasGateway()
    ) {
      return false;
    }
    const source = await state.credentialSources.findCredentialSource(
      agent.namespaceId,
      auth.sourceId,
    );
    const gateway = dependencies.sourceDrivers.credentialGatewayDriver();
    if (
      source?.state !== "ready" ||
      source.egress !== undefined ||
      source.ownerCapability !== "credential_gateway" ||
      source.driverId !== gateway.id
    ) {
      return false;
    }
    let type: CredentialSourceType;
    try {
      type = await dependencies.sourceDrivers.credentialSourceType(gateway, source.type);
    } catch (error) {
      if (error instanceof CredentialSourceTypeNotOfferedError) {
        return false;
      }
      throw error;
    }
    if (type.harnessAuth === undefined || !staticSourceLifecycleMatches(type)) {
      return false;
    }
    const snapshot: HarnessAuthSnapshot = {
      method: "credential_source",
      sourceId: source.id,
      sourceType: source.type,
      credentialGatewayId: gateway.id,
      loginMode: type.harnessAuth.loginMode,
    };
    return admitted === undefined || isDeepStrictEqual(admitted, snapshot);
  }

  function staticSourceLifecycleMatches(
    type: CredentialSourceType,
    provider?: CredentialSourceType,
  ): boolean {
    return (
      supportsStaticCredentials(type) &&
      (provider === undefined || supportsStaticCredentials(provider))
    );
  }

  function staticSourceTypeAvailable(type: CredentialSourceType): boolean {
    try {
      const selection = staticEgressProvider(type);
      if (
        !selection ||
        !staticSourceLifecycleMatches(type, selection.provider.sourceType) ||
        selection.provider.sourceType.secrets.length !== 1
      ) {
        return false;
      }
      selection.assertCurrent();
      return true;
    } catch (error) {
      if (error instanceof ResourceStateConflictError) {
        return false;
      }
      throw error;
    }
  }

  /** A protected source is offered only by the selected pair and its installed lifecycle owner. */
  function protectedSourceTypes() {
    if (!dependencies.hasProxy()) {
      return [];
    }
    const driver = dependencies.selectedProxyOwner().require("credential_proxy");
    return driver.sourceControl.providers.flatMap((provider) => {
      const issuer = dependencies.issuer(provider.ref);
      return issuer || isDeepStrictEqual(provider.ref, credentialFreeProviderRef)
        ? [{ driver, type: provider.sourceType, issuer }]
        : [];
    });
  }

  return {
    admitPreparedTokenSource,
    admitCredentialFreeMetadata,
    staticEgressProvider,
    admitStaticEgressSource,
    admitProxyPlan,
    ordinaryCredentialGatewayAllowed,
    ordinaryModelBinding,
    staticSourceLifecycleMatches,
    staticSourceTypeAvailable,
    protectedSourceTypes,
  };
}
