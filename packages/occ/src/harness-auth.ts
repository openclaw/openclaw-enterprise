import type { AgentCredentialAccess } from "./agent-credential-access.ts";
import { isManagedTokenServiceSource } from "./credential-source-metadata.ts";
import {
  isSecretHarnessAuth,
  normalizeHarnessAuthBinding,
  type Agent,
  type BackendDefinition,
  type BackendRef,
  type ComputeDriver,
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
import { resolveConfiguredHarnessId } from "./configured-harness.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { InstalledDriver } from "./installed-driver.ts";
import {
  ConfigurationHarnessError,
  DependencyUnavailableError,
  HarnessAuthSecretDriverError,
  ResourceStateConflictError,
  ScopeViolationError,
  ServiceAccountDriverNotConfiguredError,
} from "./errors.ts";
import { secretOperation, type SecretOperations } from "./secret-operations.ts";
import type { ServiceAccountOperations } from "./service-account-operations.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

interface HarnessAuthDependencies {
  readonly authority: Pick<ControllerAuthority, "authorize" | "authorizeAgentPrincipal">;
  readonly authorizeBoundCredentialSources: AgentCredentialAccess["authorizeBoundCredentialSources"];
  readonly backends: ReadonlyMap<string, BackendDefinition>;
  readonly secrets: Pick<SecretOperations, "ownedSecretDriver" | "secretDriver">;
  readonly hasCredentialProxyDelivery: () => boolean;
  readonly selectedCredentialDeliveryOwner: () => InstalledDriver;
  readonly ownedTokenServiceDriver: (instanceId: string) => unknown;
  readonly serviceAccounts: Pick<
    ServiceAccountOperations,
    "hasServiceAccountDriver" | "serviceAccountDriverId"
  >;
  readonly sandboxDriver: () => SandboxDriver | undefined;
  readonly requireModelSource: (
    compute: ComputeDriver,
    harness: RevisionHarnessDescriptor,
    auth: HarnessAuthSnapshot,
    configuration: OpenClawConfigurationDocument,
  ) => void;
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
      if (!isManagedTokenServiceSource(source) || source.state !== "ready") {
        throw new ScopeViolationError(
          "The selected Harness requires a ready TokenService Source in this Namespace.",
        );
      }
      dependencies.ownedTokenServiceDriver(source.tokenServiceInstanceId);
    } else {
      throw new ResourceStateConflictError(
        "Bind the issued ServiceAccount's Credential Source instead.",
      );
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
  ): Promise<HarnessAuthSnapshot> {
    const binding = harnessAuthBinding(agent.harnessAuth);
    if (binding === null) {
      throw new ResourceStateConflictError(
        "Deployment requires an explicit Harness authentication binding.",
      );
    }
    await authorizeHarnessAuthSource(state, principalId, agent.namespaceId, binding);
    if (binding.method === "runtime") {
      return immutableCopy(binding);
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
      return immutableCopy({ ...binding, secretDriverId: driver.id });
    }
    if (binding.method === "credential_source") {
      await dependencies.authority.authorizeAgentPrincipal(principalId, agent, "operate", {
        kind: "credential_source",
        namespaceId: agent.namespaceId,
        id: binding.sourceId,
      });
      return credentialSourceHarnessAuthSnapshot(state, agent.namespaceId, binding);
    }
    return serviceAccountHarnessAuthSnapshot(state, agent.namespaceId, agent.backendId, binding);
  }

  async function credentialSourceHarnessAuthSnapshot(
    state: PlatformUnitOfWork,
    namespaceId: string,
    binding: Extract<HarnessAuthBinding, { readonly method: "credential_source" }>,
  ): Promise<HarnessAuthSnapshot> {
    const source = await state.credentialSources.lockCredentialSource(
      namespaceId,
      binding.sourceId,
    );
    if (!isManagedTokenServiceSource(source) || source.state !== "ready") {
      throw new ScopeViolationError("The selected Harness requires a ready TokenService Source.");
    }
    dependencies.ownedTokenServiceDriver(source.tokenServiceInstanceId);
    if (
      source.type !== "static" &&
      (source.type !== "oauth2-refresh-token" || source.consent.kind !== "builtin_codex")
    ) {
      throw new ResourceStateConflictError(
        "This TokenService source cannot authenticate a staged model deployment.",
      );
    }
    return immutableCopy({
      method: "credential_source" as const,
      sourceId: source.id,
      sourceType: source.type,
      tokenServiceInstanceId: source.tokenServiceInstanceId,
    });
  }

  async function serviceAccountHarnessAuthSnapshot(
    state: PlatformUnitOfWork,
    namespaceId: string,
    _backendId: BackendRef,
    binding: Extract<HarnessAuthBinding, { readonly source: ServiceAccountReference }>,
  ): Promise<HarnessAuthSnapshot> {
    const account = await state.serviceAccounts.lockServiceAccount(namespaceId, binding.source.id);
    if (account?.credential?.kind !== "access_token") {
      throw missingAccessTokenError();
    }
    throw new ResourceStateConflictError(
      "Bind the issued ServiceAccount's Credential Source instead.",
    );
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

  function requireCredentialSourceDrivers(
    auth: HarnessAuthSnapshot,
    sandbox: SandboxDriver | undefined,
  ): void {
    if (auth.method === "credential_source") {
      requireCredentialSourceSandbox(sandbox);
      if (auth.tokenServiceInstanceId !== undefined) {
        if (!dependencies.hasCredentialProxyDelivery()) {
          throw new ResourceStateConflictError(
            "A staged credential deployment requires a selected Credential Proxy.",
          );
        }
        if (dependencies.selectedCredentialDeliveryOwner().require("sandbox") !== sandbox) {
          throw new ResourceStateConflictError(
            "A staged credential deployment requires its selected Sandbox owner.",
          );
        }
      } else {
        throw new ResourceStateConflictError("Harness credentials require a TokenService Source.");
      }
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
    dependencies.requireModelSource(compute, harness, auth, values);
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
    requireModelSource: dependencies.requireModelSource,
    authorizeHarnessAuthSource,
    authorizeBoundHarnessAuth,
    admitHarnessAuth,
    credentialSourceHarnessAuthSnapshot,
    serviceAccountHarnessAuthSnapshot,
    savedHarnessAuthSnapshot,
    plannedHarnessAuthSnapshot,
    secretHarnessAuthSnapshot,
    requireCredentialSourceDrivers,
    requireSavedHarnessAuth,
  };
}
