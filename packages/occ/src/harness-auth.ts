import {
  isSecretHarnessAuth,
  normalizeHarnessAuthBinding,
  type Agent,
  type BackendDefinition,
  type BackendRef,
  type ComputeDriver,
  type CredentialGatewayDriver,
  type CredentialSource,
  type CredentialSourceType,
  type HarnessAuthBinding,
  type HarnessAuthSnapshot,
  type HarnessExecutionMode,
  type OpenClawConfigurationDocument,
  type RevisionHarnessDescriptor,
  type SandboxDriver,
  type SecretReference,
  type ServiceAccountReference,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";
import { validateServiceAccountBackendBinding } from "./backends.ts";
import { resolveConfiguredHarnessId } from "./configured-harness.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import {
  ConfigurationHarnessError,
  DependencyUnavailableError,
  HarnessAuthSecretDriverError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretBindingValidationError,
  ServiceAccountDriverNotConfiguredError,
} from "./errors.ts";
import { secretOperation, type SecretOperations } from "./secret-operations.ts";
import type { ServiceAccountOperations } from "./service-account-operations.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { exactServiceAccount } from "./service-account-operations.ts";

type ManagedSource = CredentialSource & {
  readonly ownerCapability: "token_service";
  readonly tokenServiceInstanceId: string;
};

interface HarnessAuthDependencies {
  readonly authority: Pick<ControllerAuthority, "authorize" | "authorizeAgentPrincipal">;
  readonly authorizeBoundCredentialSources: (
    principalId: string,
    namespaceId: string,
    sources: readonly { readonly sourceId: string }[],
  ) => Promise<void>;
  readonly backends: ReadonlyMap<string, BackendDefinition>;
  readonly secrets: Pick<SecretOperations, "ownedSecretDriver" | "secretDriver">;
  readonly isManagedTokenServiceSource: (
    source: Readonly<CredentialSource> | undefined,
  ) => source is Readonly<ManagedSource>;
  readonly hasCredentialGateway: () => boolean;
  readonly assertCredentialGatewaySelected: () => void;
  readonly ownedTokenServiceDriver: (instanceId: string) => unknown;
  readonly ownedCredentialGatewayDriver: (
    source: Readonly<CredentialSource>,
  ) => CredentialGatewayDriver;
  readonly credentialGatewayDriver: (expectedId: string) => CredentialGatewayDriver;
  readonly credentialSourceType: (
    driver: CredentialGatewayDriver,
    type: string,
  ) => Promise<CredentialSourceType>;
  readonly serviceAccounts: Pick<
    ServiceAccountOperations,
    "hasServiceAccountDriver" | "serviceAccountDriverId"
  >;
  readonly sandboxDriver: () => SandboxDriver | undefined;
  readonly agentRuntimeConfiguration: (
    values: Readonly<OpenClawConfigurationDocument>,
    harness: RevisionHarnessDescriptor,
    compute: ComputeDriver,
    sandbox: SandboxDriver | undefined,
  ) => Readonly<OpenClawConfigurationDocument>;
}

/** A Secret-backed Harness authentication method whose Secret is not saved yet. */
export interface PlannedSecretHarnessAuth {
  readonly method: "api_key" | "codex_pat";
}

// The request alone determines this refusal before any grant or account lookup.
export const SERVICE_ACCOUNT_CROSS_NAMESPACE =
  "Agent setting harnessAuth.source names a ServiceAccount in another Namespace. Harness authentication can use only a ServiceAccount in the Agent's own Namespace: select one from this Namespace.";

export function harnessAuthBinding(value: unknown): HarnessAuthBinding | null {
  try {
    return normalizeHarnessAuthBinding(value);
  } catch {
    throw new ScopeViolationError("The Agent Harness authentication binding is invalid.");
  }
}

export function plannedHarnessAuth(
  value: unknown,
): HarnessAuthBinding | PlannedSecretHarnessAuth | null {
  const planned = asRecord(value);
  if (
    planned !== undefined &&
    Object.keys(planned).length === 1 &&
    (planned.method === "api_key" || planned.method === "codex_pat")
  ) {
    return Object.freeze({ method: planned.method });
  }
  return harnessAuthBinding(value);
}

export function requireCredentialSourceSandbox(sandbox: SandboxDriver | undefined): void {
  if (sandbox === undefined) {
    throw new ResourceStateConflictError(
      "Credential-source Harness authentication requires a selected Sandbox Driver.",
    );
  }
}

export function createHarnessAuthOperations(dependencies: HarnessAuthDependencies) {
  const { secrets, serviceAccounts } = dependencies;
  async function authorizeHarnessAuthSource(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    binding: HarnessAuthBinding | null,
  ): Promise<void> {
    if (binding === null || binding.method === "runtime") {
      return;
    }
    if (isSecretHarnessAuth(binding)) {
      if (binding.source.namespaceId !== namespaceId) {
        throw new ScopeViolationError("Harness authentication sources cannot cross Namespaces.");
      }
      await dependencies.authority.authorize(principalId, "operate", binding.source);
      const source = await state.secrets.lockSecret(namespaceId, binding.source.id);
      if (source === undefined) {
        throw new ScopeViolationError("The Harness Secret does not belong to the exact Namespace.");
      }
      secrets.ownedSecretDriver(source.driverId, () => new HarnessAuthSecretDriverError());
    } else if (binding.method === "credential_source") {
      await dependencies.authority.authorize(principalId, "operate", {
        kind: "credential_source",
        namespaceId,
        id: binding.sourceId,
      });
      const source = await state.credentialSources.lockCredentialSource(
        namespaceId,
        binding.sourceId,
      );
      if (!dependencies.isManagedTokenServiceSource(source)) {
        dependencies.assertCredentialGatewaySelected();
      }
      if (source === undefined || source.state !== "ready") {
        throw new ScopeViolationError(
          "The Harness credential source is unavailable in the exact Namespace.",
        );
      }
      if (dependencies.isManagedTokenServiceSource(source)) {
        dependencies.ownedTokenServiceDriver(source.tokenServiceInstanceId);
      } else {
        dependencies.ownedCredentialGatewayDriver(source);
      }
    } else {
      if (binding.source.namespaceId !== namespaceId) {
        throw new SecretBindingValidationError(SERVICE_ACCOUNT_CROSS_NAMESPACE);
      }
      await dependencies.authority.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: binding.source.id,
      });
      await exactServiceAccount(state, namespaceId, binding.source.id);
    }
  }

  async function authorizeBoundHarnessAuth(
    principalId: string,
    namespaceId: string,
    binding: HarnessAuthBinding | null,
  ): Promise<void> {
    if (binding === null || binding.method === "runtime") {
      return;
    }
    if (binding.method === "credential_source") {
      await dependencies.authorizeBoundCredentialSources(principalId, namespaceId, [
        { sourceId: binding.sourceId },
      ]);
    } else if (isSecretHarnessAuth(binding)) {
      await dependencies.authority.authorize(principalId, "operate", {
        kind: "secret",
        namespaceId,
        id: binding.source.id,
      });
    } else {
      await dependencies.authority.authorize(principalId, "read", {
        kind: "service_account",
        namespaceId,
        id: binding.source.id,
      });
    }
  }

  async function admitHarnessAuth(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Readonly<Agent>,
  ): Promise<readonly [HarnessAuthSnapshot, CredentialSourceType?]> {
    const binding = harnessAuthBinding(agent.harnessAuth);
    if (binding === null) {
      throw new ResourceStateConflictError(
        "Deployment requires an explicit Harness authentication binding.",
      );
    }
    await authorizeHarnessAuthSource(state, principalId, agent.namespaceId, binding);
    if (binding.method === "runtime") {
      return [immutableCopy(binding)];
    }
    if (isSecretHarnessAuth(binding)) {
      await dependencies.authority.authorizeAgentPrincipal(
        principalId,
        agent,
        "operate",
        binding.source,
      );
      const source = await state.secrets.lockSecret(agent.namespaceId, binding.source.id);
      if (source === undefined) {
        throw new ScopeViolationError("The Harness Secret is unavailable.");
      }
      const driver = secrets.secretDriver(source.driverId);
      const resolved = await secretOperation(() => driver.resolve(source));
      if (
        Object.keys(source.backendRef).some(
          (key) =>
            resolved[key as keyof typeof resolved] !==
            source.backendRef[key as keyof typeof source.backendRef],
        )
      ) {
        throw new DependencyUnavailableError("The Harness Secret backend identity changed.");
      }
      return [immutableCopy({ ...binding, secretDriverId: driver.id })];
    }
    if (binding.method === "credential_source") {
      await dependencies.authority.authorizeAgentPrincipal(principalId, agent, "operate", {
        kind: "credential_source",
        namespaceId: agent.namespaceId,
        id: binding.sourceId,
      });
      return credentialSourceHarnessAuthSnapshot(state, agent.namespaceId, binding);
    }
    return [
      await serviceAccountHarnessAuthSnapshot(state, agent.namespaceId, agent.backendId, binding),
    ];
  }

  async function credentialSourceHarnessAuthSnapshot(
    state: PlatformUnitOfWork,
    namespaceId: string,
    binding: Extract<HarnessAuthBinding, { readonly method: "credential_source" }>,
  ): Promise<readonly [HarnessAuthSnapshot, CredentialSourceType]> {
    const source = await state.credentialSources.lockCredentialSource(
      namespaceId,
      binding.sourceId,
    );
    if (source === undefined || source.state !== "ready") {
      throw new ScopeViolationError("The Harness credential source is unavailable.");
    }
    if (dependencies.isManagedTokenServiceSource(source)) {
      // TODO: Replace this refusal when revision delivery can freeze and dispatch this owner.
      throw new ResourceStateConflictError(
        "Agent revision delivery for this TokenService source is not available. To deploy, select supported Harness authentication and remove this staged source from the Agent's credential sources.",
      );
    }
    const gateway = dependencies.ownedCredentialGatewayDriver(source);
    const type = await dependencies.credentialSourceType(gateway, source.type);
    if (type.harnessAuth === undefined) {
      throw new ResourceStateConflictError(
        "The credential source type cannot authenticate a Harness.",
      );
    }
    return immutableCopy([
      {
        method: "credential_source" as const,
        sourceId: source.id,
        credentialGatewayId: gateway.id,
        sourceType: source.type,
        loginMode: type.harnessAuth.loginMode,
      },
      type,
    ] as const);
  }

  async function serviceAccountHarnessAuthSnapshot(
    state: PlatformUnitOfWork,
    namespaceId: string,
    backendId: BackendRef,
    binding: Extract<HarnessAuthBinding, { readonly source: ServiceAccountReference }>,
  ): Promise<HarnessAuthSnapshot> {
    const account = await state.serviceAccounts.lockServiceAccount(namespaceId, binding.source.id);
    if (account?.credential?.kind !== "access_token") {
      throw missingAccessTokenError();
    }
    const backendBinding = await state.serviceAccounts.findServiceAccountBackendBinding(
      namespaceId,
      binding.source.id,
    );
    validateServiceAccountBackendBinding(dependencies.backends, backendId, backendBinding);
    const driverId = serviceAccounts.serviceAccountDriverId();
    if (backendBinding === undefined || driverId !== backendBinding.driverId) {
      throw new DependencyUnavailableError(
        "The Harness ServiceAccount Driver does not match the admitted Backend.",
      );
    }
    return immutableCopy({
      ...binding,
      credential: { kind: "access_token" as const, secretRef: account.credential.secretRef },
      backendBinding,
    });
  }

  // Draft validation can snapshot a saved Secret without resolving its value.
  async function savedHarnessAuthSnapshot(
    state: PlatformReadView,
    namespaceId: string,
    binding: HarnessAuthBinding | null,
  ): Promise<HarnessAuthSnapshot | undefined> {
    if (binding?.method === "runtime") {
      return binding;
    }
    if (binding === null || !isSecretHarnessAuth(binding)) {
      return undefined;
    }
    const source = await state.secrets.findSecret(namespaceId, binding.source.id);
    return source === undefined
      ? undefined
      : immutableCopy({ ...binding, secretDriverId: source.driverId });
  }

  // Preflight can check the planned method and selected Driver before the Secret exists.
  function plannedHarnessAuthSnapshot(
    namespaceId: string,
    binding: HarnessAuthBinding | PlannedSecretHarnessAuth | null,
  ): HarnessAuthSnapshot | undefined {
    if (binding?.method === "runtime") {
      return binding;
    }
    if (binding === null || binding.method === "credential_source") {
      return undefined;
    }
    if ("source" in binding) {
      return isSecretHarnessAuth(binding) ? secretHarnessAuthSnapshot(binding) : undefined;
    }
    const source: SecretReference = {
      kind: "secret",
      id: "sec_00000000-0000-4000-8000-000000000000",
      namespaceId,
    };
    return secretHarnessAuthSnapshot(
      binding.method === "api_key"
        ? { method: "api_key", source }
        : { method: "codex_pat", source },
    );
  }

  function secretHarnessAuthSnapshot(
    binding: Extract<HarnessAuthBinding, { readonly source: SecretReference }>,
  ): HarnessAuthSnapshot {
    return immutableCopy({ ...binding, secretDriverId: secrets.secretDriver().id });
  }

  function assertCredentialGatewayDelivery(binding: HarnessAuthBinding | null): void {
    if (
      dependencies.hasCredentialGateway() &&
      binding !== null &&
      binding.method !== "credential_source" &&
      binding.method !== "runtime"
    ) {
      throw new ResourceStateConflictError(
        "The selected Credential Gateway requires credential-source Harness authentication.",
      );
    }
  }

  function requireCredentialSourceDrivers(
    auth: HarnessAuthSnapshot,
    sandbox: SandboxDriver | undefined,
  ): void {
    if (auth.method === "credential_source") {
      requireCredentialSourceSandbox(sandbox);
      dependencies.credentialGatewayDriver(auth.credentialGatewayId);
    }
  }

  // Preflight exposes actionable Configuration errors before the Compute provisioning check.
  // Full admission repeats the check with the admitted binding and Configuration.
  function requireSavedHarnessAuth(
    namespaceId: string,
    compute: ComputeDriver,
    executionMode: HarnessExecutionMode,
    harnessAuth: HarnessAuthBinding,
    values: Readonly<OpenClawConfigurationDocument>,
  ): void {
    const auth = plannedHarnessAuthSnapshot(namespaceId, harnessAuth);
    if (auth === undefined || compute.validateHarnessAuth === undefined) {
      return;
    }
    let harnessId: string;
    try {
      harnessId = resolveConfiguredHarnessId(values);
    } catch {
      // A model selection that names no supported Harness: admission refuses it below.
      return;
    }
    const harness = { id: harnessId, version: "provisioning", mode: executionMode };
    try {
      compute.validateHarnessAuth(
        harness,
        auth,
        dependencies.agentRuntimeConfiguration(
          values,
          harness,
          compute,
          dependencies.sandboxDriver(),
        ),
        null,
      );
    } catch (error) {
      if (error instanceof ConfigurationHarnessError) {
        throw error;
      }
    }
  }

  // API calls see the selected Driver. Workers can identify its configured ID.
  function missingAccessTokenError() {
    return serviceAccounts.hasServiceAccountDriver()
      ? new ResourceStateConflictError(
          "ChatGPT Harness authentication requires an issued account access-token credential.",
        )
      : new ServiceAccountDriverNotConfiguredError("deploy");
  }

  return {
    authorizeHarnessAuthSource,
    authorizeBoundHarnessAuth,
    admitHarnessAuth,
    credentialSourceHarnessAuthSnapshot,
    serviceAccountHarnessAuthSnapshot,
    savedHarnessAuthSnapshot,
    plannedHarnessAuthSnapshot,
    secretHarnessAuthSnapshot,
    assertCredentialGatewayDelivery,
    requireCredentialSourceDrivers,
    requireSavedHarnessAuth,
  };
}
