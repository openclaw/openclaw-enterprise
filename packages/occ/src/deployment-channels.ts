import { driverOperation } from "./driver-operation.ts";
import { deploymentSandboxPolicy } from "./sandbox-policy.ts";
import type {
  ChannelDriver,
  Configuration,
  ConfigurationDriver,
  OpenClawConfigurationDocument,
  SecretBindings,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { exactConfiguration, storedSecretBindings } from "./configuration-operations.ts";
import { secretOperation, sameSecretBackend } from "./secret-operations.ts";
import {
  AuthorizationDeniedError,
  ChannelCredentialError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretBindingDriverError,
  type SecretDriverOwnershipError,
} from "./errors.ts";
import type { DeployAgentInput } from "./deployment-authorization.ts";
import { unchangedDriver, type DriverRegistry } from "./driver-registry.ts";
import { exactNamespace } from "./resource-scope.ts";

type DeploymentConfigurationMetadata = Readonly<
  Pick<Configuration, "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings">
>;

export interface PreparedDeploymentChannels {
  readonly configuration: Readonly<Configuration>;
  readonly configurationDriver: ConfigurationDriver;
  readonly channel: ChannelDriver | undefined;
  readonly channelValidator: ChannelDriver["validateCredentials"];
}

interface DeploymentChannelDependencies {
  readonly transactions: Pick<ControllerTransactions, "read" | "hasContext">;
  readonly authority: Pick<ControllerAuthority, "authorize">;
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
  async function validateChannelCredentials(
    principalId: string,
    namespaceId: string,
    configuration: Pick<Configuration, "values" | "secretBindings">,
    driverFailure: () => SecretDriverOwnershipError,
    driver = dependencies.drivers.selection("channel")?.driver as ChannelDriver | undefined,
    authorizeUse?: () => Promise<void>,
  ): Promise<void> {
    if (driver?.validateCredentials === undefined) {
      return undefined;
    }
    if (dependencies.transactions.hasContext()) {
      throw new ResourceConflictError(
        "Channel validation must run outside a controller transaction.",
      );
    }
    const bindings = storedSecretBindings(configuration.secretBindings);
    await driver.validateCredentials(configuration.values, async (binding, path, validate) => {
      const source = bindings[binding]?.source;
      if (source === undefined) {
        throw new ChannelCredentialError("binding_required", path);
      }
      if (source.namespaceId !== namespaceId) {
        throw new ScopeViolationError("Secret references cannot cross Namespaces.");
      }
      await dependencies.authority.authorize(principalId, "operate", source);
      const secret = await dependencies.transactions.read(async (state) => {
        await exactNamespace(state, namespaceId);
        return state.secrets.findSecret(namespaceId, source.id);
      });
      if (secret === undefined) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      const storage = dependencies.ownedSecretDriver(secret.driverId, driverFailure);
      if (storage.withValue === undefined) {
        throw new ChannelCredentialError("unavailable", path);
      }
      await authorizeUse?.();
      await dependencies.authority.authorize(principalId, "operate", source);
      const outcome = await secretOperation(() =>
        storage.withValue!(secret, async (value) => {
          // Reauthorize after backend I/O and before sending a credential to its provider.
          try {
            await authorizeUse?.();
            await dependencies.authority.authorize(principalId, "operate", source);
            const current = await dependencies.transactions.read(async (state) => {
              await exactNamespace(state, namespaceId);
              return state.secrets.findSecret(namespaceId, source.id);
            });
            if (
              current === undefined ||
              !sameSecretBackend(secret, current) ||
              dependencies.ownedSecretDriver(current.driverId, driverFailure) !== storage
            ) {
              throw new ChannelCredentialError("unavailable", path);
            }
            await validate(value);
            return undefined;
          } catch (error) {
            return {
              error:
                error instanceof ChannelCredentialError || error instanceof AuthorizationDeniedError
                  ? error
                  : new ChannelCredentialError("unavailable", path),
            };
          }
        }),
      );
      if (outcome?.error !== undefined) {
        throw outcome.error;
      }
    });
  }

  async function validateDeploymentChannels(
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
    return prepareDeploymentChannels(principalId, input, metadata);
  }

  async function prepareDeploymentChannels(
    principalId: string,
    input: DeployAgentInput,
    metadata: DeploymentConfigurationMetadata | undefined,
  ): Promise<PreparedDeploymentChannels> {
    if (metadata?.kind !== "agent") {
      throw new ScopeViolationError("The Agent Configuration is unavailable.");
    }
    const namespaceId = input.namespaceId;
    const agentId = input.agentId;
    const configurationId = metadata.id;
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
    const channelValidator = channel?.validateCredentials;
    await validateChannelCredentials(
      principalId,
      namespaceId,
      configuration,
      () => new SecretBindingDriverError(),
      channel,
      async () => {
        await dependencies.authority.authorize(principalId, "deploy", {
          kind: "agent",
          id: agentId,
          namespaceId,
        });
        await dependencies.authority.authorize(principalId, "read", {
          kind: "configuration",
          id: configurationId,
          namespaceId,
        });
      },
    );
    return { configuration, configurationDriver, channel, channelValidator };
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
    validateDeploymentChannels,
    prepareDeploymentChannels,
    assertPreparedDeploymentDrivers,
  };
}
