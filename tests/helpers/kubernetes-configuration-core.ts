import type { resolveKubernetesControlNamespace } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  FakeNamespaceCoreV1Api,
  injectedFailure,
  stallUntilAborted,
} from "./kubernetes-core-api.ts";

type ConfigurationCoreApi = Pick<
  Parameters<typeof resolveKubernetesControlNamespace>[0],
  | "listNamespace"
  | "createNamespacedConfigMap"
  | "readNamespacedConfigMap"
  | "replaceNamespacedConfigMap"
  | "deleteNamespacedConfigMap"
>;

type ConfigurationMethod = keyof ConfigurationCoreApi;
type ConfigurationRequest<Method extends ConfigurationMethod> = Parameters<
  ConfigurationCoreApi[Method]
>[0];
type ConfigMap = Awaited<ReturnType<ConfigurationCoreApi["readNamespacedConfigMap"]>>;

// In-memory stand-ins for the CoreV1Api calls the Kubernetes Configuration Driver makes. They
// are not live SDK or cluster proof: the Driver's transport is covered by its own tests.
export class FakeConfigurationCoreV1Api extends FakeNamespaceCoreV1Api {
  configMaps = new Map<string, ConfigMap>();
  creates = 0;

  async createNamespacedConfigMap({
    namespace,
    body,
  }: ConfigurationRequest<"createNamespacedConfigMap">): Promise<ConfigMap> {
    this.creates += 1;
    const key = `${namespace}/${body.metadata!.name}`;
    if (this.configMaps.has(key)) {
      throw Object.assign(new Error("conflict"), { code: 409 });
    }
    const stored = {
      ...structuredClone(body),
      metadata: {
        ...body.metadata,
        uid: `uid-${this.configMaps.size + 1}`,
        resourceVersion: "1",
      },
    };
    this.configMaps.set(key, stored);
    return structuredClone(stored);
  }

  async readNamespacedConfigMap({
    namespace,
    name,
  }: ConfigurationRequest<"readNamespacedConfigMap">): Promise<ConfigMap> {
    const stored = this.configMaps.get(`${namespace}/${name}`);
    if (stored === undefined) {
      throw Object.assign(new Error("missing ConfigMap"), { code: 404 });
    }
    return structuredClone(stored);
  }
}

// The fake API with failures queued per method, each thrown before the call takes
// effect, and a method that can stall until its request is aborted.
export class FlakyConfigurationCoreV1Api
  extends FakeConfigurationCoreV1Api
  implements ConfigurationCoreApi
{
  failureCodes: Record<ConfigurationMethod, (number | string)[]> = {
    listNamespace: [],
    readNamespacedConfigMap: [],
    createNamespacedConfigMap: [],
    replaceNamespacedConfigMap: [],
    deleteNamespacedConfigMap: [],
  };
  calls: Record<ConfigurationMethod, number> = {
    listNamespace: 0,
    readNamespacedConfigMap: 0,
    createNamespacedConfigMap: 0,
    replaceNamespacedConfigMap: 0,
    deleteNamespacedConfigMap: 0,
  };
  stalls = new Set<ConfigurationMethod>();

  async called(method: ConfigurationMethod) {
    this.calls[method] += 1;
    const failure = this.failureCodes[method].shift();
    if (failure !== undefined) {
      throw injectedFailure(failure, method);
    }
    if (this.stalls.has(method)) {
      await stallUntilAborted(method);
    }
  }

  override async listNamespace(
    request: ConfigurationRequest<"listNamespace"> & { labelSelector: string },
  ): ReturnType<ConfigurationCoreApi["listNamespace"]> {
    await this.called("listNamespace");
    return super.listNamespace(request);
  }

  override async readNamespacedConfigMap(
    request: ConfigurationRequest<"readNamespacedConfigMap">,
  ): Promise<ConfigMap> {
    await this.called("readNamespacedConfigMap");
    return super.readNamespacedConfigMap(request);
  }

  override async createNamespacedConfigMap(
    request: ConfigurationRequest<"createNamespacedConfigMap">,
  ): Promise<ConfigMap> {
    await this.called("createNamespacedConfigMap");
    return super.createNamespacedConfigMap(request);
  }

  async replaceNamespacedConfigMap({
    namespace,
    name,
    body,
  }: ConfigurationRequest<"replaceNamespacedConfigMap">): Promise<ConfigMap> {
    await this.called("replaceNamespacedConfigMap");
    const stored = {
      ...structuredClone(body),
      metadata: { ...body.metadata, resourceVersion: "2" },
    };
    this.configMaps.set(`${namespace}/${name}`, stored);
    return structuredClone(stored);
  }

  async deleteNamespacedConfigMap({
    namespace,
    name,
  }: ConfigurationRequest<"deleteNamespacedConfigMap">): ReturnType<
    ConfigurationCoreApi["deleteNamespacedConfigMap"]
  > {
    await this.called("deleteNamespacedConfigMap");
    this.configMaps.delete(`${namespace}/${name}`);
    return {};
  }
}
