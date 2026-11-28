import {
  normalizeAgentNetworkProxy,
  type AgentNetworkProxy,
  type ComputeDriver,
  type CredentialSourceReference,
  type HarnessExecutionMode,
  type OpenClawConfigurationDocument,
  type StoredCredentialSource,
  type TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import { enabledChannelEntries } from "./channel-secret-bindings.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import {
  ConfigurationHarnessError,
  NetworkProxyValidationError,
  NetworkProxyEnforcementUnavailableError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";

export function requestNetworkProxy(value: unknown): Readonly<AgentNetworkProxy> {
  try {
    return normalizeAgentNetworkProxy(value);
  } catch {
    throw new NetworkProxyValidationError();
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

export function createNetworkProxySourceAuthorization(dependencies: {
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly selectedCompute: () => ComputeDriver | undefined;
  readonly ownedTokenServiceDriver: (instanceId: string) => TokenServiceDriver;
  readonly qualifiesDelivery:
    ((compute: ComputeDriver, owner: TokenServiceDriver) => boolean) | undefined;
}) {
  return async function authorizeNetworkProxySource(
    principalId: string,
    namespaceId: string,
    selection: Readonly<AgentNetworkProxy> | undefined,
    findSource: (id: string) => Promise<Readonly<StoredCredentialSource> | undefined>,
  ): Promise<{ sourceRef: CredentialSourceReference; tokenServiceInstanceId: string } | undefined> {
    const id = selection?.credentialSourceId;
    if (id === undefined) {
      return undefined;
    }
    const sourceRef = { kind: "credential_source", namespaceId, id } as const;
    await dependencies.authority.authorize(principalId, "operate", sourceRef);
    const source = await findSource(id);
    if (!source || source.namespaceId !== namespaceId) {
      throw new ScopeViolationError(
        "The Network proxy Credential Source does not belong to the exact Namespace.",
      );
    }
    if (
      source.ownerCapability !== "token_service" ||
      source.type !== "static" ||
      source.state !== "ready"
    ) {
      throw new ResourceStateConflictError(
        "Network proxy credentials require a ready static TokenService Credential Source.",
      );
    }
    const compute = dependencies.selectedCompute();
    const owner = dependencies.ownedTokenServiceDriver(source.tokenServiceInstanceId);
    if (
      !compute?.admitGatewayChannelProxy ||
      dependencies.qualifiesDelivery?.(compute, owner) !== true
    ) {
      throw new ResourceStateConflictError(
        "The selected Compute and TokenService do not support Network proxy Source delivery.",
      );
    }
    return { sourceRef, tokenServiceInstanceId: source.tokenServiceInstanceId };
  };
}
