import {
  FakeNamespaceCoreV1Api,
  injectedFailure,
  stallUntilAborted,
} from "./kubernetes-core-api.mjs";

// In-memory stand-ins for the CoreV1Api calls the Kubernetes Configuration Driver makes. They
// are not live SDK or cluster proof: the Driver's transport is covered by its own tests.
export class FakeConfigurationCoreV1Api extends FakeNamespaceCoreV1Api {
  configMaps = new Map();
  creates = 0;

  async createNamespacedConfigMap({ namespace, body }) {
    this.creates += 1;
    const key = `${namespace}/${body.metadata.name}`;
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

  async readNamespacedConfigMap({ namespace, name }) {
    const stored = this.configMaps.get(`${namespace}/${name}`);
    if (stored === undefined) {
      throw Object.assign(new Error("missing ConfigMap"), { code: 404 });
    }
    return structuredClone(stored);
  }
}

// The fake API with failures queued per method, each thrown before the call takes
// effect, and a method that can stall until its request is aborted.
export class FlakyConfigurationCoreV1Api extends FakeConfigurationCoreV1Api {
  failureCodes = {
    listNamespace: [],
    readNamespacedConfigMap: [],
    createNamespacedConfigMap: [],
    replaceNamespacedConfigMap: [],
    deleteNamespacedConfigMap: [],
  };
  calls = Object.fromEntries(Object.keys(this.failureCodes).map((method) => [method, 0]));
  stalls = new Set();

  async called(method) {
    this.calls[method] += 1;
    const failure = this.failureCodes[method].shift();
    if (failure !== undefined) {
      throw injectedFailure(failure, method);
    }
    if (this.stalls.has(method)) {
      await stallUntilAborted(method);
    }
  }

  async listNamespace(request) {
    await this.called("listNamespace");
    return super.listNamespace(request);
  }

  async readNamespacedConfigMap(request) {
    await this.called("readNamespacedConfigMap");
    return super.readNamespacedConfigMap(request);
  }

  async createNamespacedConfigMap(request) {
    await this.called("createNamespacedConfigMap");
    return super.createNamespacedConfigMap(request);
  }

  async replaceNamespacedConfigMap({ namespace, name, body }) {
    await this.called("replaceNamespacedConfigMap");
    const stored = {
      ...structuredClone(body),
      metadata: { ...body.metadata, resourceVersion: "2" },
    };
    this.configMaps.set(`${namespace}/${name}`, stored);
    return structuredClone(stored);
  }

  async deleteNamespacedConfigMap({ namespace, name }) {
    await this.called("deleteNamespacedConfigMap");
    this.configMaps.delete(`${namespace}/${name}`);
    return {};
  }
}
