import { AsyncLocalStorage } from "node:async_hooks";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { driverOperation } from "./driver-operation.ts";
import { deploymentSandboxPolicy } from "./sandbox-policy.ts";
import type {
  ChannelDriver,
  Configuration,
  ConfigurationDriver,
  OpenClawConfigurationDocument,
  Secret,
  SecretBindings,
  SecretDriver,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { exactConfiguration, storedSecretBindings } from "./configuration-operations.ts";
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

  async function startDeploymentValidation(
    principalId: string,
    deployment: DeploymentChannelUse,
    source: SecretReference,
    handoff: (
      current: Readonly<Secret> | undefined,
      assertPolicy?: () => void,
    ) => ChannelValidation,
  ): Promise<ChannelValidation> {
    const rollback = new Error("Channel policy preview completed");
    let validation: ChannelValidation | undefined;
    try {
      const preview = async (state: PlatformUnitOfWork) => {
        await dependencies.authority.holdAuthority(state);
        await lockNamespace(state, deployment.target.namespaceId);
        await dependencies.authority.authorize(principalId, "operate", source);
        const current = await state.secrets.findSecret(source.namespaceId, source.id);
        const policy = await authorizeDeploymentChannelUse(state, principalId, deployment);
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
          throw new ScopeViolationError("Secret references cannot cross Namespaces.");
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
            // The Driver runs with its original context, outside the controller unit.
            // Call it synchronously under the lock and await its result after release.
            const send = AsyncLocalStorage.bind(async (): Promise<ChannelOutcome> => {
              try {
                await validate(value);
                return undefined;
              } catch (error) {
                // Only the Channel contract's credential outcome can leave this callback.
                return {
                  error:
                    error instanceof ChannelCredentialError
                      ? error
                      : new ChannelCredentialError("unavailable", path),
                };
              }
            });
            const handoff = (current: Readonly<Secret> | undefined, assertPolicy?: () => void) => {
              if (
                current === undefined ||
                !sameSecretBackend(secret, current) ||
                dependencies.ownedSecretDriver(current.driverId, driverFailure) !== storage
              ) {
                throw new ChannelCredentialError("unavailable", path);
              }
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
            try {
              if (typeof use === "function") {
                await authorizeUse();
                return await handoff(await readSecret()).completed;
              }
              const result = await startDeploymentValidation(principalId, use, source, handoff);
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
