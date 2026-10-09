import type {
  ObservableMiddleware,
  RequestContext,
  ResponseContext,
} from "@kubernetes/client-node";
import { currentComputeAbortSignal } from "../compute/operation-context.ts";
import type { KubernetesAuthentication } from "./authentication.ts";

type KubernetesSdk = typeof import("@kubernetes/client-node");

type KubernetesClientConfiguration = ReturnType<
  typeof import("@kubernetes/client-node").createConfiguration
>;

type ValidationFailure = (message: string) => Error;

export async function createKubernetesClientConfiguration(
  authentication: KubernetesAuthentication,
  validationFailure: ValidationFailure,
): Promise<{
  readonly sdk: KubernetesSdk;
  readonly clientConfiguration: KubernetesClientConfiguration;
  readonly kubeConfig: import("@kubernetes/client-node").KubeConfig;
  readonly server: string;
}> {
  let sdk: KubernetesSdk;
  try {
    sdk = await import("@kubernetes/client-node");
  } catch {
    throw validationFailure("The Kubernetes client package is unavailable.");
  }

  const configuration = new sdk.KubeConfig();
  if (authentication.mode === "inCluster") {
    configuration.loadFromCluster();
  } else {
    configuration.loadFromFile(authentication.kubeconfigPath);
    const contexts = configuration
      .getContexts()
      .filter((context) => context.name === authentication.context);
    const selected = contexts[0];
    if (contexts.length !== 1 || selected === undefined) {
      throw validationFailure(
        "The kubeconfig must contain exactly one explicitly requested context.",
      );
    }
    if (
      configuration.getClusters().filter((cluster) => cluster.name === selected.cluster).length !==
      1
    ) {
      throw validationFailure("The explicit context must select exactly one Kubernetes cluster.");
    }
    configuration.setCurrentContext(authentication.context);
    if (configuration.getCurrentContext() !== authentication.context) {
      throw validationFailure("The requested Kubernetes context could not be selected.");
    }
  }

  const cluster = configuration.getCurrentCluster();
  if (cluster === null || configuration.getCurrentUser() == null) {
    throw validationFailure("The selected Kubernetes cluster or credential identity is missing.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(cluster.server);
  } catch {
    throw validationFailure("The selected Kubernetes API server URL is invalid.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    cluster.skipTLSVerify === true
  ) {
    throw validationFailure(
      "The Kubernetes API server must use verified HTTPS and configured trust roots.",
    );
  }

  const cancellationMiddleware: ObservableMiddleware = {
    pre(request: RequestContext) {
      const signal = currentComputeAbortSignal();
      if (signal !== undefined) {
        signal.throwIfAborted();
        request.setSignal(signal);
      }
      return new sdk.Observable(Promise.resolve(request));
    },
    post(response: ResponseContext) {
      return new sdk.Observable(Promise.resolve(response));
    },
  };
  const clientConfiguration = sdk.createConfiguration({
    baseServer: new sdk.ServerConfiguration(cluster.server, {}),
    authMethods: { default: configuration },
    middleware: [cancellationMiddleware],
  });
  return { sdk, clientConfiguration, kubeConfig: configuration, server: cluster.server };
}

/**
 * The Kubernetes API server did not answer (connection refused, reset, or timed
 * out). It names only the endpoint so startup logs can say which dependency and
 * address failed without exposing credentials or client error objects.
 */
export class KubernetesApiUnavailableError extends Error {
  readonly host: string;
  readonly port: number;

  constructor(server: string, options?: ErrorOptions) {
    const endpoint = new URL(server);
    const host = endpoint.hostname.replace(/^\[(.*)\]$/, "$1");
    const port = endpoint.port === "" ? 443 : Number(endpoint.port);
    super(`The Kubernetes API server at ${host}:${port} is unreachable.`, options);
    this.name = "KubernetesApiUnavailableError";
    this.host = host;
    this.port = port;
  }
}
