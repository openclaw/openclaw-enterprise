import type {
  Backend,
  Namespace,
  OpenShellBackendDefinition,
  OpenShellBackendConfiguration,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString, publicCaBundle, sha256Hex } from "@openclaw-enterprise/utils";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

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

/** The gateway's Service name and the Kubernetes namespace its Pods run in. */
export interface OpenShellGatewayPlacement {
  readonly service: string;
  readonly namespace: string;
}

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
  private readonly credentialClients = new Map<string, OpenShellGatewayClient>();

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

  /** Export uses a distinct operator identity without broadening ordinary RPC authority. */
  credentialClientForNamespace(
    namespace: string,
  ): Pick<OpenShellGatewayClient, "getProviderCredential"> {
    if (this.injectedClient !== undefined) {
      return this.injectedClient;
    }
    const operatorTls = this.configuration.operatorTls;
    if (operatorTls === undefined) {
      throw new OpenShellBackendConfigurationFailure(
        "OpenShell credential retrieval requires operatorTls certificate and private key paths.",
      );
    }
    const options: OpenShellGatewayClientOptions = {
      ...this.clientOptions(namespace),
      auth: { mode: "mutualTls", ...operatorTls },
    };
    const existing = this.credentialClients.get(options.endpoint);
    if (existing !== undefined) {
      return existing;
    }
    const created = new GrpcOpenShellGatewayClient(options);
    this.credentialClients.set(options.endpoint, created);
    return created;
  }

  /**
   * Where the gateway runs, when the configuration names it (finding 1356). A bare Service name
   * runs in each tenant `namespace`, so it needs one. A dotted Service name, or an endpoint host
   * `<service>.<namespace>.svc[.<cluster domain>]`, one Pod's
   * `<pod>.<service>-peer.<namespace>.svc[...]` or one port's
   * `<port>.<protocol>.<service>.<namespace>.svc[...]` (finding 1369), names one namespace. An IP
   * address, a node address or any other host names none.
   */
  placement(namespace?: string): OpenShellGatewayPlacement | undefined {
    const { endpoint, serviceName } = this.configuration;
    if (endpoint !== undefined) {
      return serviceDnsPlacement(
        new URL(endpoint.includes("://") ? endpoint : `http://${endpoint}`).hostname,
      );
    }
    const labels = (serviceName as string).toLowerCase().split(".");
    if (labels.length === 1) {
      return namespace === undefined ? undefined : { service: labels[0]!, namespace };
    }
    return labels.length === 2
      ? { service: labels[0]!, namespace: labels[1]! }
      : serviceDnsPlacement(serviceName as string);
  }

  close(): void {
    this.injectedClient?.close();
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    for (const client of this.credentialClients.values()) {
      client.close();
    }
    this.credentialClients.clear();
  }

  /** Only the configured public root may cross into a Harness endpoint contract. */
  publicRootCertificate(): string | undefined {
    const path = this.configuration.rootCertificatePath;
    if (path === undefined) {
      return undefined;
    }
    if (!isAbsolute(path)) {
      throw new OpenShellBackendConfigurationFailure(
        "The OpenShell Backend root certificate requires an absolute path.",
      );
    }
    try {
      return publicCaBundle(readFileSync(path, "utf8"));
    } catch {
      throw new OpenShellBackendConfigurationFailure(
        "The OpenShell Backend root must be a readable public PEM CA certificate bundle.",
      );
    }
  }

  private clientOptions(namespace: string): OpenShellGatewayClientOptions {
    const configuration = this.configuration;
    return {
      endpoint: configuration.endpoint ?? serviceEndpoint(configuration, namespace),
      // TODO(namespaced OpenShell identities): the OAuth PoC deliberately shares one
      // installation identity for ordinary RPCs and an operator certificate for exports.
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

/**
 * `<service>.<namespace>.svc[...]`, a StatefulSet Pod's `<pod>.<service>-peer.<namespace>.svc[...]`
 * or a port's `<port>.<protocol>.<service>.<namespace>.svc[...]`, which CoreDNS answers like the
 * Service (an `_` before the port and protocol is optional). A Service or namespace named `svc` is
 * read as the first form that fits.
 */
function serviceDnsPlacement(host: string): OpenShellGatewayPlacement | undefined {
  const labels = host.toLowerCase().split(".");
  if (labels[2] === "svc") {
    return { service: labels[0]!, namespace: labels[1]! };
  }
  if (labels[3] === "svc") {
    return { service: labels[1]!.replace(/-peer$/, ""), namespace: labels[2]! };
  }
  return labels[4] === "svc" ? { service: labels[2]!, namespace: labels[3]! } : undefined;
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
