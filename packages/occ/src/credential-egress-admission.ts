import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  credentialFreeMetadataGrant,
  credentialFreeMetadataType,
  credentialFreeProviderRef,
  isInstallationRepositoryProfile,
  repositoryGitAuthorization,
  repositoryGitDeliveryProfile,
  type Agent,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type CredentialFreeEgressSource,
  type CredentialProviderDefinition,
  type LegacyCredentialSource,
  type DriverByCapability,
  type EgressRef,
  type OpenClawConfigurationDocument,
  type PreparedTokenIssuer,
  type PreparedTokenSource,
  type ProxyPlan,
  type RepositoryRevisionState,
  type Secret,
  type SecretReference,
  type CredentialService,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";
import {
  matchesAdmittedSourceType,
  registeredCredentialProvider,
} from "./credential-provider-selection.ts";
import { PROTECTED_SOURCE_TIMEOUT_MS } from "./credential-source-drivers.ts";
import {
  AgentDeletingError,
  ConfigurationHarnessError,
  CredentialProxyAdmissionError,
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
  readonly installationId: string;
  readonly authorize: (
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: AuthorizationRequest["resource"],
  ) => Promise<Readonly<{ request: AuthorizationRequest; decision: AuthorizationDecision }>>;
  readonly hasProxy: () => boolean;
  readonly proxyDriver: () => DriverByCapability["credential_proxy"];
  readonly proxyRegistrationOwner: () => InstalledDriver | undefined;
  readonly selectedProxyOwner: () => InstalledDriver;
  readonly issuer: (ref: EgressRef) => ReturnType<CredentialService["issuer"]>;
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
    await control.assertAvailable(AbortSignal.timeout(PROTECTED_SOURCE_TIMEOUT_MS));
    return {
      source: immutableCopy({
        key: {
          installationId: dependencies.installationId,
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
    await control.assertAvailable(AbortSignal.timeout(PROTECTED_SOURCE_TIMEOUT_MS));
    return immutableCopy({
      key: {
        installationId: dependencies.installationId,
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

  async function admitProxyPlan(
    state: PlatformUnitOfWork,
    agent: Readonly<Agent>,
    revisionId: string,
    configuration: OpenClawConfigurationDocument,
    sandboxDriverId?: string,
    repositoryGit?: RepositoryRevisionState,
    harnessConfiguration?: Readonly<Record<string, unknown>>,
    nativeGit?: "v1",
  ): Promise<{ plan: ProxyPlan; assertProvidersCurrent: () => void } | undefined> {
    const sources: LegacyCredentialSource[] = [];
    for (const binding of agent.credentialSources ?? []) {
      const source = await state.credentialSources.findCredentialSource(
        agent.namespaceId,
        binding.sourceId,
      );
      if (source?.ownerCapability !== "credential_service" && source?.egress !== undefined) {
        sources.push(source);
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
    const sourceCount = sources.length;
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
      AbortSignal.timeout(PROTECTED_SOURCE_TIMEOUT_MS),
      gitProfile,
      nativeGit,
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
        AbortSignal.timeout(PROTECTED_SOURCE_TIMEOUT_MS),
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
      installationId: dependencies.installationId,
      namespaceId: agent.namespaceId,
      agentId: agent.id,
      servicePrincipalId: agent.servicePrincipalId,
      revisionId,
      executionId: repositoryGit ? randomBytes(24).toString("base64url") : crypto.randomUUID(),
    };
    const control = driver.sourceControl;
    const requireProvider = (
      source: LegacyCredentialSource,
      expected?: CredentialProviderDefinition,
    ) => {
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
        (gitAuthorization === "online-request" ||
          gitAuthorization === "request-hook-observed" ||
          gitAuthorization === "network-policy") && {
          repositoryGitAuthorization: gitAuthorization,
        }),
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
    admitProxyPlan,
    protectedSourceTypes,
  };
}
