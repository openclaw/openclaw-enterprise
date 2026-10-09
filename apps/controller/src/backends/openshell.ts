import type {
  Backend,
  Namespace,
  OpenShellBackendDefinition,
  OpenShellBackendConfiguration,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";

import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClient,
  type OpenShellGatewayClientOptions,
} from "../drivers/sandbox/openshell-gateway-client.ts";

const DEFAULT_GATEWAY_PORT = 8080;
const OPENSHELL_MAX_WORKSPACE_NAME_LENGTH = 19;
/** Provider names OCC creates; the paired Sandbox Driver accepts only this shape. */
const OCC_PROVIDER_NAME = /^oce-cs-[0-9a-f]{24}$/;

export class OpenShellBackendConfigurationFailure extends Error {}

export interface OpenShellGatewaySelection {
  /** Replaces gRPC clients for every namespace, as when a caller owns the transport. */
  readonly gatewayClient?: OpenShellGatewayClient;
}

/**
 * The authenticated OpenShell gateway shared by the Sandbox and Credential Gateway Drivers.
 * A bare Service name resolves in each Sandbox namespace, so clients are cached per endpoint.
 */
export class OpenShellGateway {
  private readonly configuration: OpenShellBackendConfiguration;
  private readonly injectedClient: OpenShellGatewayClient | undefined;
  private readonly clients = new Map<string, OpenShellGatewayClient>();

  constructor(
    configuration: OpenShellBackendConfiguration,
    selection: OpenShellGatewaySelection = {},
  ) {
    if (configuration.endpoint === undefined && !isNonEmptyString(configuration.serviceName)) {
      throw new OpenShellBackendConfigurationFailure(
        "The OpenShell Backend requires an endpoint or a gateway Service name.",
      );
    }
    this.configuration = configuration;
    this.injectedClient = selection.gatewayClient;
  }

  clientForNamespace(namespace: string): OpenShellGatewayClient {
    if (this.injectedClient !== undefined) {
      return this.injectedClient;
    }
    const options = this.clientOptions(namespace);
    const existing = this.clients.get(options.endpoint);
    if (existing !== undefined) {
      return existing;
    }
    const created = new GrpcOpenShellGatewayClient(options);
    this.clients.set(options.endpoint, created);
    return created;
  }

  close(): void {
    this.injectedClient?.close();
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }

  private clientOptions(namespace: string): OpenShellGatewayClientOptions {
    const configuration = this.configuration;
    return {
      endpoint: configuration.endpoint ?? serviceEndpoint(configuration, namespace),
      // TODO(namespaced OpenShell identities): the OAuth PoC deliberately shares one
      // installation platform-admin identity for provider writes and warm-token reads.
      // Namespace selection changes routing, not identity; later identity provisioning
      // belongs here, while OCC continues authorizing each source operation.
      ...(configuration.auth === undefined ? {} : { auth: configuration.auth }),
      ...(configuration.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: configuration.requestTimeoutMs }),
      ...(configuration.rootCertificatePath === undefined
        ? {}
        : { rootCertificatePath: configuration.rootCertificatePath }),
    };
  }
}

function serviceEndpoint(configuration: OpenShellBackendConfiguration, namespace: string): string {
  const serviceName = configuration.serviceName as string;
  const scheme =
    configuration.scheme ?? (configuration.rootCertificatePath === undefined ? "http" : "https");
  const host = serviceName.includes(".") ? serviceName : `${serviceName}.${namespace}.svc`;
  return `${scheme}://${host}:${configuration.port ?? DEFAULT_GATEWAY_PORT}`;
}

export function createOpenShellBackend(
  definition: OpenShellBackendDefinition,
  selection: OpenShellGatewaySelection = {},
): Backend<OpenShellGateway> {
  return Object.freeze({
    id: definition.id,
    client: new OpenShellGateway(definition.configuration, selection),
    drivers: Object.freeze({ ...definition.drivers }),
  });
}

/** Operator-mode Workspaces reuse the exact Kubernetes namespace name. */
export function openShellWorkspaceName(namespace: Readonly<Namespace>): string {
  const name = namespace.name;
  if (
    !isNonEmptyString(name) ||
    name.length > OPENSHELL_MAX_WORKSPACE_NAME_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
  ) {
    throw new OpenShellBackendConfigurationFailure(
      "OpenShell operator-mode Workspace names require a Kubernetes namespace name that is a DNS-1123 label of at most 19 characters.",
    );
  }
  return name;
}

/** One OpenShell provider per OCC credential source, named without exposing the source ID. */
export function openShellProviderName(sourceId: string): string {
  return `oce-cs-${sha256Hex(sourceId, 24)}`;
}

export function isOpenShellProviderName(value: string): boolean {
  return OCC_PROVIDER_NAME.test(value);
}
