import { createHash } from "node:crypto";

import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

// In-memory stand-ins for the CoreV1Api calls the Kubernetes Configuration Driver makes. They
// are not live SDK or cluster proof: the Driver's transport is covered by its own tests.
function physicalNamespaceName(id) {
  return `oce-${createHash("sha256").update(id).digest("hex").slice(0, 15)}`;
}

export class FakeConfigurationCoreV1Api {
  namespaces = new Map();
  configMaps = new Map();
  creates = 0;

  addNamespace(id, layout = "shared") {
    const name =
      layout === "split"
        ? `oce-gateways-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`
        : layout === "adopted"
          ? "customer-support"
          : physicalNamespaceName(id);
    this.namespaces.set(name, {
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/gateway-namespace": id,
          ...(layout === "split" ? {} : { "openclaw.dev/namespace": id }),
          ...(layout === "adopted"
            ? Object.fromEntries(
                ["enforce", "audit", "warn"].map((mode) => [
                  `pod-security.kubernetes.io/${mode}`,
                  "restricted",
                ]),
              )
            : {}),
        },
        annotations: {
          "openclaw.dev/namespace-id": id,
          ...(layout === "adopted" ? { "openclaw.dev/namespace-lifecycle": "external" } : {}),
        },
      },
      status: { phase: "Active" },
    });
    return name;
  }

  async listNamespace({ labelSelector }) {
    const [label, id] = labelSelector.split("=");
    return {
      items: [...this.namespaces.values()].filter(
        ({ metadata }) => metadata.labels?.[label] === id,
      ),
    };
  }

  async readNamespace({ name }) {
    const namespace = this.namespaces.get(name);
    if (namespace === undefined) {
      throw Object.assign(new Error("missing Namespace"), { code: 404 });
    }
    return structuredClone(namespace);
  }

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
    if (failure === "dropped") {
      // What the client throws when the API server closes the connection unanswered.
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    if (failure !== undefined) {
      throw Object.assign(new Error(`${method} failed with ${failure}`), { code: failure });
    }
    if (this.stalls.has(method)) {
      const signal = currentComputeAbortSignal();
      if (signal === undefined) {
        throw new Error(`${method} would stall with no deadline`);
      }
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
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
