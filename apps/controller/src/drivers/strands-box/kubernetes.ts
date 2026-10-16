import type { KubeConfig } from "@kubernetes/client-node";
import { request, type RequestOptions } from "node:https";
import { isDeepStrictEqual } from "node:util";
import type { KubernetesAuthentication } from "../kubernetes/authentication.ts";
import { createKubernetesClientConfiguration } from "../kubernetes/client.ts";

export type Resource = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    uid?: string;
    resourceVersion?: string;
    deletionTimestamp?: string;
    ownerReferences?: readonly unknown[];
  };
  data?: Record<string, string>;
  immutable?: boolean;
  spec?: Record<string, unknown>;
  status?: {
    podIP?: string;
    phase?: string;
    containerStatuses?: {
      name: string;
      containerID?: string;
      imageID?: string;
      ready?: boolean;
      state?: { running?: object };
    }[];
  };
};

export const owner = "openclaw.dev/strands-execution";
export const hash = "openclaw.dev/strands-policy-sha256";
const versions: Record<string, string> = {
  Pod: "pods",
  Secret: "secrets",
  ConfigMap: "configmaps",
  Service: "services",
  PersistentVolumeClaim: "persistentvolumeclaims",
  NetworkPolicy: "networkpolicies",
};

/** The selected execution API, with bounded bodies/deadlines and no redirect or mutation retries. */
export class ExecutionKubernetes {
  private configuration: () => Promise<KubeConfig>;

  constructor(input: KubeConfig | KubernetesAuthentication) {
    let configuration: Promise<KubeConfig> | undefined;
    this.configuration = () =>
      (configuration ??=
        "mode" in input
          ? createKubernetesClientConfiguration(input, (message) => new Error(message)).then(
              ({ kubeConfig }) => kubeConfig,
            )
          : Promise.resolve(input));
  }

  async text(
    path: string,
    signal: AbortSignal,
    options: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      allow?: number[];
    } = {},
  ): Promise<{ status: number; text: string }> {
    const config = await this.configuration();
    const cluster = config.getCurrentCluster();
    if (!cluster || cluster.skipTLSVerify || !cluster.server.startsWith("https://")) {
      throw new Error("Strands requires a verified HTTPS execution Kubernetes API.");
    }
    const requestOptions: RequestOptions = { method: options.method ?? "GET" };
    await config.applyToHTTPSOptions(requestOptions);
    const abort = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    abort.throwIfAborted();
    return new Promise((resolve, reject) => {
      const call = request(
        new URL(path, cluster.server),
        {
          ...requestOptions,
          signal: abort,
          headers: {
            ...requestOptions.headers,
            "content-type": "application/json",
            ...options.headers,
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if ((status < 200 || status >= 300) && !options.allow?.includes(status)) {
            response.resume();
            reject(
              new Error(
                "Execution Kubernetes " +
                  requestOptions.method +
                  " " +
                  path.split("?")[0] +
                  " returned " +
                  status,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if ((bytes += chunk.length) > 4_194_304) {
              call.destroy(new Error("Oversize execution API response."));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString() }));
          response.on("error", reject);
        },
      );
      call.on("error", reject);
      call.end(options.body);
    });
  }

  path(namespace: string, kind: string, name?: string): string {
    return (
      (kind === "NetworkPolicy" ? "/apis/networking.k8s.io/v1" : "/api/v1") +
      "/namespaces/" +
      encodeURIComponent(namespace) +
      "/" +
      versions[kind] +
      (name ? "/" + encodeURIComponent(name) : "")
    );
  }

  async read(namespace: string, kind: string, name: string, signal: AbortSignal) {
    const { status, text } = await this.text(this.path(namespace, kind, name), signal, {
      allow: [404],
    });
    return status === 404 ? undefined : (JSON.parse(text) as Resource);
  }

  async list(namespace: string, kind: string, signal: AbortSignal): Promise<Resource[]> {
    const { text } = await this.text(this.path(namespace, kind), signal);
    const list = JSON.parse(text);
    if (list.metadata?.continue || !Array.isArray(list.items)) {
      throw new Error("Incomplete execution inventory.");
    }
    return list.items;
  }

  /** Create once; observe conflicts; refuse foreign, terminating or differently admitted objects. */
  async ensure(
    namespace: string,
    kind: string,
    body: Resource,
    signal: AbortSignal,
  ): Promise<Resource> {
    const { name } = body.metadata;
    const find = () => this.read(namespace, kind, name, signal);
    let resource = await find();
    if (!resource) {
      const result = await this.text(this.path(namespace, kind), signal, {
        method: "POST",
        allow: [409],
        body: JSON.stringify({
          apiVersion: kind === "NetworkPolicy" ? "networking.k8s.io/v1" : "v1",
          kind,
          ...body,
        }),
      });
      resource = result.status === 409 ? await find() : JSON.parse(result.text);
    }
    if (
      !resource?.metadata.uid ||
      resource.metadata.deletionTimestamp ||
      resource.metadata.labels?.[owner] !== body.metadata.labels?.[owner] ||
      resource.metadata.annotations?.[hash] !== body.metadata.annotations?.[hash] ||
      (kind === "NetworkPolicy" && !isDeepStrictEqual(body.spec, resource.spec))
    ) {
      throw new Error("Strands refuses changed execution installation object " + name);
    }
    return resource;
  }

  async remove(namespace: string, resource: Resource, signal: AbortSignal) {
    const path = this.path(namespace, resource.kind!, resource.metadata.name);
    await this.text(path, signal, {
      method: "DELETE",
      allow: [404],
      body: JSON.stringify({
        propagationPolicy: "Foreground",
        preconditions: {
          uid: resource.metadata.uid,
          resourceVersion: resource.metadata.resourceVersion,
        },
      }),
    });
  }
}
