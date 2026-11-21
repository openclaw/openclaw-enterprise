import {
  normalizeAgentNetworkProxy,
  validNetworkProxyAuthorization,
  type AgentNetworkProxy,
  type ComputeDriver,
  type HarnessExecutionMode,
  type OpenClawConfigurationDocument,
  type Secret,
  type SecretDriver,
} from "@openclaw-enterprise/contracts";
import { enabledChannelEntries } from "./channel-secret-bindings.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import {
  ConfigurationHarnessError,
  DependencyUnavailableError,
  NetworkProxySecretDriverError,
  NetworkProxyValidationError,
  NetworkProxyEnforcementUnavailableError,
  ScopeViolationError,
  type SecretDriverOwnershipError,
} from "./errors.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

export function requestNetworkProxy(value: unknown): Readonly<AgentNetworkProxy> {
  try {
    return normalizeAgentNetworkProxy(value);
  } catch {
    throw new NetworkProxyValidationError("selection");
  }
}

export async function admitNetworkProxy(
  compute: ComputeDriver | undefined,
  selection: Readonly<AgentNetworkProxy> | undefined,
  executionMode: HarnessExecutionMode,
  configuration: Readonly<OpenClawConfigurationDocument>,
): Promise<string | undefined> {
  if (selection === undefined) {
    return undefined;
  }
  if (compute?.admitGatewayChannelProxy === undefined) {
    throw new ConfigurationHarnessError(
      "The selected Compute Driver does not support a Gateway channel Network proxy.",
    );
  }
  try {
    const admission = await compute.admitGatewayChannelProxy(selection, {
      executionMode,
      channelsEnabled: enabledChannelEntries(configuration).length > 0,
    });
    if (!admission) {
      throw new Error("Missing admission.");
    }
    return admission;
  } catch (error) {
    if (error instanceof ConfigurationHarnessError) {
      throw error;
    }
    throw new NetworkProxyEnforcementUnavailableError();
  }
}

export async function authorizeNetworkProxySecret(
  state: PlatformUnitOfWork,
  authority: Pick<ControllerAuthority, "authorize">,
  ownedSecretDriver: (id: string, failure: () => SecretDriverOwnershipError) => SecretDriver,
  principalId: string,
  namespaceId: string,
  selection: Readonly<AgentNetworkProxy> | undefined,
): Promise<Readonly<Secret> | undefined> {
  const id = selection?.credentialSecretId;
  if (id === undefined) {
    return undefined;
  }
  await authority.authorize(principalId, "operate", { kind: "secret", namespaceId, id });
  const secret = await state.secrets.lockSecret(namespaceId, id);
  if (secret === undefined) {
    throw new ScopeViolationError(
      "The Network proxy Secret does not belong to the exact Namespace.",
    );
  }
  const driver = ownedSecretDriver(secret.driverId, () => new NetworkProxySecretDriverError());
  await validateNetworkProxyCredential(driver, secret);
  return secret;
}

export async function validateNetworkProxyCredential(
  driver: SecretDriver,
  secret: Readonly<Secret>,
): Promise<void> {
  if (!driver.withValue) {
    throw new DependencyUnavailableError(
      "The selected Secret Driver cannot validate Network proxy credentials.",
    );
  }
  let valid: boolean;
  try {
    valid = await driver.withValue(secret, async (value) => validNetworkProxyAuthorization(value));
  } catch {
    throw new DependencyUnavailableError("The Network proxy credential Secret is unavailable.");
  }
  if (!valid) {
    throw new NetworkProxyValidationError("credential");
  }
}
