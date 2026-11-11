import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  Watch,
  setHeaderOptions,
} from "@kubernetes/client-node";
import { OPERATOR_GROUP, OPERATOR_VERSION } from "./crds.ts";

export type ResourceKind = "OCEConnection" | "OCENamespace" | "OCESecret" | "OCEAgent";
export const PLURALS: Readonly<Record<ResourceKind, string>> = {
  OCEConnection: "oceconnections",
  OCENamespace: "ocenamespaces",
  OCESecret: "ocesecrets",
  OCEAgent: "oceagents",
};

export interface Resource {
  readonly apiVersion: string;
  readonly kind: ResourceKind;
  readonly metadata: {
    readonly name: string;
    readonly uid: string;
    readonly resourceVersion: string;
    readonly generation: number;
    readonly namespace: string;
    readonly deletionTimestamp?: string;
    readonly finalizers?: readonly string[];
  };
  readonly spec: Record<string, unknown>;
  readonly status?: Record<string, unknown>;
}

export function statusCode(error: unknown): number | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}

export class ClusterResources {
  private readonly objects: CustomObjectsApi;
  private readonly core: CoreV1Api;
  private readonly patchOptions = setHeaderOptions("Content-Type", "application/merge-patch+json");
  readonly watch: Watch;

  readonly configuration: KubeConfig;
  readonly namespace: string;
  constructor(configuration: KubeConfig, namespace: string) {
    this.configuration = configuration;
    this.namespace = namespace;

    this.objects = configuration.makeApiClient(CustomObjectsApi);
    this.core = configuration.makeApiClient(CoreV1Api);
    this.watch = new Watch(configuration);
  }

  private target(kind: ResourceKind) {
    return {
      group: OPERATOR_GROUP,
      version: OPERATOR_VERSION,
      namespace: this.namespace,
      plural: PLURALS[kind],
    };
  }

  async get(kind: ResourceKind, name: string): Promise<Resource> {
    return (await this.objects.getNamespacedCustomObject({
      ...this.target(kind),
      name,
    })) as Resource;
  }

  async list(
    kind: ResourceKind,
  ): Promise<{ items: Resource[]; metadata: { resourceVersion: string } }> {
    return (await this.objects.listNamespacedCustomObject(this.target(kind))) as {
      items: Resource[];
      metadata: { resourceVersion: string };
    };
  }

  async secret(name: string, key: string): Promise<string> {
    const secret = await this.core.readNamespacedSecret({ name, namespace: this.namespace });
    const encoded = secret.data?.[key];
    if (encoded === undefined) {
      throw new Error("The approved Secret key is unavailable.");
    }
    return Buffer.from(encoded, "base64").toString("utf8");
  }

  async namespaceUid(): Promise<string> {
    const namespace = await this.core.readNamespace({ name: this.namespace });
    if (namespace.metadata?.uid === undefined) {
      throw new Error("The Operator Namespace identity is unavailable.");
    }
    return namespace.metadata.uid;
  }

  async status(resource: Resource, status: Record<string, unknown>): Promise<void> {
    await this.objects.replaceNamespacedCustomObjectStatus({
      ...this.target(resource.kind),
      name: resource.metadata.name,
      body: {
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        metadata: {
          name: resource.metadata.name,
          namespace: this.namespace,
          resourceVersion: resource.metadata.resourceVersion,
        },
        status,
      },
    });
  }

  async finalizers(resource: Resource, finalizers: readonly string[]): Promise<void> {
    await this.objects.patchNamespacedCustomObject(
      {
        ...this.target(resource.kind),
        name: resource.metadata.name,
        body: {
          metadata: { resourceVersion: resource.metadata.resourceVersion, finalizers },
        },
      },
      this.patchOptions,
    );
  }
}
