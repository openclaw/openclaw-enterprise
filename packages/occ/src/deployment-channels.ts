import { AsyncLocalStorage } from "node:async_hooks";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { driverOperation } from "./driver-operation.ts";
import { PROTECTED_SOURCE_TIMEOUT_MS } from "./credential-source-drivers.ts";
import { deploymentSandboxPolicy } from "./sandbox-policy.ts";
import type {
  ChannelDriver,
  ComputeDriver,
  Configuration,
  ConfigurationDriver,
  CredentialSourceReference,
  OpenClawConfigurationDocument,
  Secret,
  SecretBindings,
  SecretDriver,
  SecretReference,
  StoredCredentialSource,
  TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  exactConfiguration,
  requireDedicatedGatewaySources,
  storedSecretBindings,
} from "./configuration-operations.ts";
import { secretOperation, sameSecretBackend } from "./secret-operations.ts";
import {
  AuthorizationDeniedError,
  ChannelCredentialError,
  DependencyUnavailableError,
  RepositoryPolicyDeploymentConflict,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretBindingDriverError,
  type SecretDriverOwnershipError,
} from "./errors.ts";
import type { DeployAgentInput } from "./deployment-authorization.ts";
import { unchangedDriver, type DriverRegistry } from "./driver-registry.ts";
import { exactNamespace, lockNamespace } from "./resource-scope.ts";

type DeploymentConfigurationMetadata = Readonly<
  Pick<Configuration, "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings">
>;

export interface PreparedDeploymentChannels {
  readonly configuration: Readonly<Configuration>;
  readonly configurationDriver: ConfigurationDriver;
  readonly channel: ChannelDriver | undefined;
  readonly channelValidator: ChannelDriver["validateCredentials"];
}

type CheckChannelPolicy = () => Promise<() => void>;

type ChannelOutcome = { readonly error: Error } | undefined;
interface ChannelValidation {
  readonly completed: Promise<ChannelOutcome>;
}

class ChannelPolicyRefused extends ResourceStateConflictError {
  constructor() {
    super(
      "The saved repository policy could not be admitted before Channel credential validation. Review the policy and selected Drivers.",
    );
  }
}

interface DeploymentChannelUse {
  readonly checkPolicy: CheckChannelPolicy;
  readonly target: { readonly kind: "agent"; readonly namespaceId: string; readonly id: string };
  readonly prepared: PreparedDeploymentChannels;
}

interface DeploymentChannelDependencies {
  readonly transactions: Pick<ControllerTransactions, "read" | "hasContext" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority">;
  readonly drivers: Pick<DriverRegistry, "hasSelection" | "selection">;
  readonly selectedChannel: () => ChannelDriver;
  readonly selectedCompute: () => ComputeDriver | undefined;
  readonly ownedTokenServiceDriver: (instanceId: string) => TokenServiceDriver;
  readonly gatewayStartupSourceDelivery:
    ((compute: ComputeDriver, owner: TokenServiceDriver) => boolean) | undefined;
  readonly configurationDriver: () => ConfigurationDriver;
  readonly requireBundledChannelBindings: (
    values: OpenClawConfigurationDocument,
    bindings: SecretBindings,
  ) => void;
  readonly ownedSecretDriver: (
    driverId: string,
    failure: () => SecretDriverOwnershipError,
  ) => SecretDriver;
}

export function createDeploymentChannelChecks(dependencies: DeploymentChannelDependencies) {
  async function authorizeDeploymentChannelUse(
    state: PlatformReadView,
    principalId: string,
    { target, prepared }: DeploymentChannelUse,
  ) {
    await dependencies.authority.authorize(principalId, "deploy", target);
    await dependencies.authority.authorize(principalId, "read", {
      kind: "configuration",
      id: prepared.configuration.id,
      namespaceId: target.namespaceId,
    });
    return deploymentSandboxPolicy(
      state,
      dependencies.authority,
      principalId,
      target.namespaceId,
      target.id,
    );
  }

  async function assertCurrentDeploymentSource(
    state: PlatformReadView,
    deployment: DeploymentChannelUse,
    binding: string,
    source: CredentialSourceReference,
  ): Promise<void> {
    const agent = await state.agents.findAgent(deployment.target.namespaceId, deployment.target.id);
    if (agent === undefined) {
      throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
    }
    requireDedicatedGatewaySources(
      deployment.prepared.configuration.secretBindings,
      agent.executionMode,
    );
    const configuration = await state.configurations.findConfiguration(
      deployment.target.namespaceId,
      agent.configurationId,
    );
    const current = configuration?.secretBindings?.[binding]?.source;
    if (
      agent.configurationId !== deployment.prepared.configuration.id ||
      configuration?.generation !== deployment.prepared.configuration.generation ||
      current?.kind !== "credential_source" ||
      current.namespaceId !== source.namespaceId ||
      current.id !== source.id
    ) {
      throw new ResourceStateConflictError(
        "The Agent or Configuration changed after Channel validation was prepared.",
      );
    }
  }

  async function startDeploymentValidation<T>(
    principalId: string,
    deployment: DeploymentChannelUse,
    source: SecretReference | CredentialSourceReference,
    find: (state: PlatformUnitOfWork) => Promise<Readonly<T> | undefined>,
    handoff: (current: Readonly<T> | undefined, assertPolicy?: () => void) => ChannelValidation,
  ): Promise<ChannelValidation> {
    const rollback = new Error("Channel policy preview completed");
    let validation: ChannelValidation | undefined;
    try {
      const preview = async (state: PlatformUnitOfWork) => {
        await dependencies.authority.holdAuthority(state);
        await lockNamespace(state, deployment.target.namespaceId);
        await dependencies.authority.authorize(principalId, "operate", source);
        const policy = await authorizeDeploymentChannelUse(state, principalId, deployment);
        const current = await find(state);
        let assertPolicy: (() => void) | undefined;
        if (current && policy?.repositoryNetworkPolicy !== undefined) {
          try {
            assertPolicy = await deployment.checkPolicy();
          } catch (error) {
            // The preview can fail on a platform dependency before the Channel receives
            // the Secret. Keep the retry classification without copying Driver diagnostics.
            if (error instanceof DependencyUnavailableError) {
              throw new DependencyUnavailableError(
                "A required dependency was unavailable during repository policy admission.",
              );
            }
            if (
              error instanceof AuthorizationDeniedError ||
              error instanceof RepositoryPolicyDeploymentConflict
            ) {
              throw error;
            }
            throw new ChannelPolicyRefused();
          }
          await authorizeDeploymentChannelUse(state, principalId, deployment);
          await dependencies.authority.authorize(principalId, "operate", source);
        }
        // Invoke the captured validator under the same locks as authorization.
        // Release the locks before waiting for the provider's response.
        validation = handoff(current, assertPolicy);
        if (!assertPolicy) {
          return validation;
        }
        // Discard grants staged by the policy preview before final admission.
        throw rollback;
      };
      // The policy preview reuses this transaction and reads IAM after the lock wait.
      return await dependencies.transactions.transact(preview, { readCommitted: true });
    } catch (error) {
      if (error === rollback && validation !== undefined) {
        return validation;
      }
      await validation?.completed;
      throw error;
    }
  }

  async function validateSourceCredential(
    source: CredentialSourceReference,
    binding: string,
    path: string,
    captureProvider: (value: string) => (assertPolicy?: () => void) => ChannelValidation,
    authorizeUse: () => Promise<unknown>,
    principalId: string,
    use: DeploymentChannelUse | (() => Promise<void>),
  ): Promise<void> {
    const authorizeOperate = () => dependencies.authority.authorize(principalId, "operate", source);
    const find = (state: PlatformReadView) =>
      state.credentialSources.findCredentialSource(source.namespaceId, source.id);
    const readySource = (current: Readonly<StoredCredentialSource> | undefined) => {
      if (
        current?.ownerCapability !== "token_service" ||
        current.type !== "static" ||
        current.state !== "ready"
      ) {
        throw new ResourceStateConflictError(
          "Channel credentials require a ready static TokenService Credential Source.",
        );
      }
      return current;
    };
    const qualify = (instanceId: string) => {
      const owner = dependencies.ownedTokenServiceDriver(instanceId);
      const compute = dependencies.selectedCompute();
      if (
        compute === undefined ||
        dependencies.gatewayStartupSourceDelivery?.(compute, owner) !== true
      ) {
        throw new ResourceStateConflictError(
          "The selected Compute and TokenService do not support Gateway Source delivery.",
        );
      }
      return { compute, owner };
    };

    await authorizeUse();
    await authorizeOperate();
    const selected = readySource(
      await dependencies.transactions.read(async (state) => {
        await exactNamespace(state, source.namespaceId);
        return find(state);
      }),
    );
    const { owner, compute } = qualify(selected.tokenServiceInstanceId);
    const currentSource = (current: Readonly<StoredCredentialSource> | undefined) => {
      const active = readySource(current);
      const qualified = qualify(active.tokenServiceInstanceId);
      if (
        active.tokenServiceInstanceId !== selected.tokenServiceInstanceId ||
        qualified.owner !== owner ||
        qualified.compute !== compute
      ) {
        throw new ChannelCredentialError("unavailable", path);
      }
    };
    const resolve = AsyncLocalStorage.bind(async () => {
      try {
        return {
          resolved: await driverOperation(
            () =>
              owner.resolveCredential(
                { sourceRef: source, tokenServiceInstanceId: selected.tokenServiceInstanceId },
                AbortSignal.timeout(PROTECTED_SOURCE_TIMEOUT_MS),
              ),
            "TokenService",
          ),
        };
      } catch {
        return { error: new ChannelCredentialError("unavailable", path) };
      }
    });
    let completed: ReturnType<typeof resolve> | undefined;
    if (typeof use === "function") {
      await authorizeUse();
      await authorizeOperate();
      completed = resolve();
    } else {
      try {
        await dependencies.transactions.transact(
          async (state) => {
            await dependencies.authority.holdAuthority(state);
            await lockNamespace(state, source.namespaceId);
            await authorizeOperate();
            await authorizeDeploymentChannelUse(state, principalId, use);
            await assertCurrentDeploymentSource(state, use, binding, source);
            currentSource(await find(state));
            completed = resolve();
          },
          { readCommitted: true },
        );
      } catch (error) {
        await completed;
        throw error;
      }
    }
    if (completed === undefined) {
      throw new ChannelCredentialError("unavailable", path);
    }
    const resolution = await completed;
    if (resolution.error !== undefined) {
      throw resolution.error;
    }
    const resolved = resolution.resolved;
    if (
      typeof resolved.credential !== "string" ||
      resolved.credential.length === 0 ||
      typeof resolved.version !== "string" ||
      resolved.version.trim().length === 0
    ) {
      throw new ChannelCredentialError("unavailable", path);
    }
    const startProvider = captureProvider(resolved.credential);
    const handoff = (
      current: Readonly<StoredCredentialSource> | undefined,
      assertPolicy?: () => void,
    ): ChannelValidation => {
      currentSource(current);
      return startProvider(assertPolicy);
    };
    let validation: ChannelValidation | undefined;
    if (typeof use === "function") {
      try {
        validation = await dependencies.transactions.transact(
          async (state) => {
            await dependencies.authority.holdAuthority(state);
            await lockNamespace(state, source.namespaceId);
            await authorizeUse();
            await authorizeOperate();
            validation = handoff(await find(state));
            return validation;
          },
          { readCommitted: true },
        );
      } catch (error) {
        await validation?.completed;
        throw error;
      }
    } else {
      validation = await startDeploymentValidation<StoredCredentialSource>(
        principalId,
        use,
        source,
        async (state) => {
          await assertCurrentDeploymentSource(state, use, binding, source);
          return find(state);
        },
        handoff,
      );
    }
    const outcome = await validation.completed;
    if (outcome?.error !== undefined) {
      throw outcome.error;
    }
  }

  async function validateChannelCredentials(
    principalId: string,
    namespaceId: string,
    configuration: Pick<Configuration, "values" | "secretBindings">,
    driverFailure: () => SecretDriverOwnershipError,
    use: DeploymentChannelUse | (() => Promise<void>),
  ): Promise<void> {
    const driver =
      typeof use === "function"
        ? (dependencies.drivers.selection("channel")?.driver as ChannelDriver | undefined)
        : use.prepared.channel;
    const channelValidator =
      typeof use === "function" ? driver?.validateCredentials : use.prepared.channelValidator;
    if (driver === undefined || channelValidator === undefined) {
      return;
    }
    if (dependencies.transactions.hasContext()) {
      throw new ResourceConflictError(
        "Channel validation must run outside a controller transaction.",
      );
    }
    const authorizeUse =
      typeof use === "function"
        ? use
        : () =>
            dependencies.transactions.read((state) =>
              authorizeDeploymentChannelUse(state, principalId, use),
            );
    const bindings = storedSecretBindings(configuration.secretBindings);
    await Reflect.apply(channelValidator, driver, [
      configuration.values,
      async (binding, path, validate) => {
        const source = bindings[binding]?.source;
        if (source === undefined) {
          throw new ChannelCredentialError("binding_required", path);
        }
        if (source.namespaceId !== namespaceId) {
          throw new ScopeViolationError("Credential references cannot cross Namespaces.");
        }
        // Capture the provider's original async context before entering the controller unit.
        // It starts under authorization locks, but its response is awaited after they release.
        const captureProvider = (value: string) => {
          const send = AsyncLocalStorage.bind(async (): Promise<ChannelOutcome> => {
            try {
              await validate(value);
              return undefined;
            } catch (error) {
              return {
                error:
                  error instanceof ChannelCredentialError
                    ? error
                    : new ChannelCredentialError("unavailable", path),
              };
            }
          });
          return (assertPolicy?: () => void): ChannelValidation => {
            if (typeof use !== "function") {
              assertPreparedDeploymentDrivers(use.prepared);
            }
            try {
              assertPolicy?.();
            } catch {
              throw new ChannelPolicyRefused();
            }
            return { completed: send() };
          };
        };

        if (source.kind === "credential_source") {
          await validateSourceCredential(
            source,
            binding,
            path,
            captureProvider,
            authorizeUse,
            principalId,
            use,
          );
          return;
        }

        const authorizeOperate = () =>
          dependencies.authority.authorize(principalId, "operate", source);
        const readSecret = async () => {
          await authorizeOperate();
          return dependencies.transactions.read(async (state) => {
            await exactNamespace(state, namespaceId);
            return state.secrets.findSecret(namespaceId, source.id);
          });
        };
        const secret = await readSecret();
        if (secret === undefined) {
          throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
        }
        const storage = dependencies.ownedSecretDriver(secret.driverId, driverFailure);
        if (storage.withValue === undefined) {
          throw new ChannelCredentialError("unavailable", path);
        }
        await authorizeUse();
        await authorizeOperate();
        const refusal = (error: unknown) => ({
          error:
            error instanceof ChannelCredentialError ||
            error instanceof ChannelPolicyRefused ||
            error instanceof RepositoryPolicyDeploymentConflict ||
            error instanceof AuthorizationDeniedError
              ? error
              : new ChannelCredentialError("unavailable", path),
        });
        const outcome = await secretOperation(() =>
          storage.withValue!(secret, async (value) => {
            const startProvider = captureProvider(value);
            const handoff = (current: Readonly<Secret> | undefined, assertPolicy?: () => void) => {
              if (
                current === undefined ||
                !sameSecretBackend(secret, current) ||
                dependencies.ownedSecretDriver(current.driverId, driverFailure) !== storage
              ) {
                throw new ChannelCredentialError("unavailable", path);
              }
              return startProvider(assertPolicy);
            };
            try {
              if (typeof use === "function") {
                await authorizeUse();
                return await handoff(await readSecret()).completed;
              }
              const result = await startDeploymentValidation(
                principalId,
                use,
                source,
                (state) => state.secrets.findSecret(source.namespaceId, source.id),
                handoff,
              );
              return await result.completed;
            } catch (error) {
              return refusal(error);
            }
          }),
        );
        if (outcome?.error !== undefined) {
          throw outcome.error;
        }
      },
    ]);
  }

  async function prepareOrdinaryDeploymentChannels(
    principalId: string,
    input: DeployAgentInput,
  ): Promise<PreparedDeploymentChannels | undefined> {
    if (dependencies.drivers.selection("channel")?.driver === undefined) {
      return undefined;
    }
    await dependencies.authority.authorize(principalId, "deploy", {
      kind: "agent",
      id: input.agentId,
      namespaceId: input.namespaceId,
    });
    const metadata = await dependencies.transactions.read(async (state) => {
      const agent = await state.agents.findAgent(input.namespaceId, input.agentId);
      if (agent === undefined) {
        throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
      }
      await dependencies.authority.authorize(principalId, "read", {
        kind: "configuration",
        id: agent.configurationId,
        namespaceId: input.namespaceId,
      });
      await deploymentSandboxPolicy(
        state,
        dependencies.authority,
        principalId,
        input.namespaceId,
        agent.id,
        input.expectedRepositoryPolicyVersion,
      );
      return state.configurations.findConfiguration(input.namespaceId, agent.configurationId);
    });
    return prepareDeploymentChannels(metadata);
  }

  async function prepareDeploymentChannels(
    metadata: DeploymentConfigurationMetadata | undefined,
  ): Promise<PreparedDeploymentChannels> {
    if (metadata?.kind !== "agent") {
      throw new ScopeViolationError("The Agent Configuration is unavailable.");
    }
    const configurationDriver = dependencies.configurationDriver();
    const configuration = exactConfiguration(
      await driverOperation(() => configurationDriver.read(metadata)),
      metadata,
    );
    // Before the Channel Driver, which reads only an env SecretRef and answers any other channel
    // credential form with its generic binding refusal: the bundled Kubernetes channel rule, then
    // the Configuration Driver's rules, in save's order (finding 2520). Deployment applies them
    // again below. A stored Configuration that predates a rule gets the message its next save
    // would, as provisioning does (findings 2506, 2516).
    dependencies.requireBundledChannelBindings(
      configuration.values,
      configuration.secretBindings ?? {},
    );
    await configurationDriver.validate(configuration);
    const channel = dependencies.drivers.hasSelection("channel")
      ? dependencies.selectedChannel()
      : undefined;
    return {
      configuration,
      configurationDriver,
      channel,
      channelValidator: channel?.validateCredentials,
    };
  }
  async function validatePreparedChannels(
    principalId: string,
    { namespaceId, agentId }: DeployAgentInput,
    prepared: PreparedDeploymentChannels,
    checkPolicy: CheckChannelPolicy,
  ) {
    await validateChannelCredentials(
      principalId,
      namespaceId,
      prepared.configuration,
      () => new SecretBindingDriverError(),
      {
        target: { kind: "agent", id: agentId, namespaceId },
        prepared,
        checkPolicy,
      },
    );
  }

  function assertPreparedDeploymentDrivers(prepared: PreparedDeploymentChannels): void {
    const configuration = dependencies.drivers.selection("configuration");
    const channel = dependencies.drivers.selection("channel");
    if (
      configuration?.driver !== prepared.configurationDriver ||
      !unchangedDriver(configuration) ||
      channel?.driver !== prepared.channel ||
      (channel !== undefined && !unchangedDriver(channel)) ||
      prepared.channel?.validateCredentials !== prepared.channelValidator
    ) {
      throw new ResourceStateConflictError(
        "The selected Drivers changed after guarded validation.",
      );
    }
  }

  return {
    validateChannelCredentials,
    prepareOrdinaryDeploymentChannels,
    validatePreparedChannels,
    prepareDeploymentChannels,
    assertPreparedDeploymentDrivers,
  };
}
